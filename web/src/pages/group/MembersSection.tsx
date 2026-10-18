import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { balanceText, Button, ErrorNote, Field, LedgerSection } from '../../components/ui';
import { api, keys, type GroupDetail } from '../../lib/api';
import { useBalances } from '../../lib/groupQueries';

const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`;

/** An invite link with a copy button; the link itself stays visible so it can be shared any way. */
function InviteLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded bg-sheet p-3">
      <p className="mb-1 text-sm font-medium">{label}</p>
      <div className="flex gap-2">
        <input readOnly value={url} aria-label={label} className="min-h-11 min-w-0 flex-1 rounded border border-field-line bg-field px-2 text-sm" onFocus={(e) => { e.target.select(); }} />
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => { setCopied(true); });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted">Works once, for 7 days.</p>
    </div>
  );
}

export function MembersSection({ group }: { group: GroupDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const balances = useBalances(group.groupId);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [links, setLinks] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: keys.group(group.groupId) });

  const addGhost = useMutation({
    mutationFn: (n: string) => api.addGhost(group.groupId, n),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const invite = useMutation({
    mutationFn: (ghostMemberId?: string) => api.createInvite(group.groupId, ghostMemberId),
    onSuccess: (r, ghostMemberId) => { setLinks((l) => ({ ...l, [ghostMemberId ?? 'group']: inviteUrl(r.token) })); },
  });
  const leave = useMutation({
    mutationFn: () => api.leave(group.groupId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.myGroups });
      await navigate('/', { replace: true });
    },
  });

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setNameError('Enter their name');
      return;
    }
    setNameError(undefined);
    addGhost.mutate(name.trim());
  };

  const myBalance = balances.data?.members.find((m) => m.memberId === group.me.memberId)?.balanceMinor;
  const leaveBlocked =
    group.me.role === 'owner'
      ? 'You started this group, so you can’t leave it yet.'
      : myBalance !== undefined && myBalance !== 0
        ? `${balanceText(myBalance, true)} in this group. Settle up before leaving.`
        : null;

  return (
    <LedgerSection title="Members" tabbed>
      <ul className="ledger">
        {group.members.map((m) => (
          <li key={m.memberId} className="py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="font-medium">{m.isMe ? `${m.name} (you)` : m.name}</span>
                <span className="block text-sm text-muted">
                  {m.isGhost ? 'Added by name, hasn’t joined yet' : m.role === 'owner' ? 'Started the group' : 'Member'}
                </span>
              </span>
              {m.isGhost && (
                <Button variant="secondary" className="min-h-9 px-3 text-sm" onClick={() => { invite.mutate(m.memberId); }}>
                  Invite {m.name}
                </Button>
              )}
            </div>
            {links[m.memberId] && <InviteLink url={links[m.memberId] ?? ''} label={`Link for ${m.name}`} />}
          </li>
        ))}
      </ul>
      <ErrorNote error={invite.error} />

      <div className="mt-4">
        <Button variant="secondary" onClick={() => { invite.mutate(undefined); }}>Create invite link</Button>
        {links.group && <InviteLink url={links.group} label="Invite link for anyone" />}
      </div>

      <form onSubmit={submit} noValidate className="mt-6 space-y-3">
        <Field
          label="Add someone by name"
          hint="They can claim their place later with an invite link."
          value={name}
          maxLength={60}
          onChange={(e) => { setName(e.target.value); }}
          error={nameError}
        />
        <ErrorNote error={addGhost.error} />
        <Button type="submit" variant="secondary" disabled={addGhost.isPending}>Add to group</Button>
      </form>

      <div className="mt-8 border-t border-rule pt-4">
        <Button
          variant="secondary"
          disabled={leaveBlocked !== null || leave.isPending}
          aria-describedby="leave-why"
          onClick={() => { if (window.confirm(`Leave ${group.name}?`)) leave.mutate(); }}
        >
          Leave group
        </Button>
        <p id="leave-why" className="mt-1 text-sm text-muted">{leaveBlocked ?? 'You can rejoin later with an invite link.'}</p>
        <ErrorNote error={leave.error} />
      </div>
    </LedgerSection>
  );
}
