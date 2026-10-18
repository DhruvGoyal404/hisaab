import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { AppShell, Button, btn, ErrorNote, Loading } from '../components/ui';
import { api, ApiError, keys } from '../lib/api';

/** Where an invite link lands: say what joining does, then join (or claim a placeholder). */
export function JoinPage() {
  const { token = '' } = useParams();
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api.previewInvite(token), retry: false });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token),
    onSuccess: async ({ groupId }) => {
      await qc.invalidateQueries({ queryKey: keys.myGroups });
      await navigate(`/groups/${groupId}`, { replace: true });
    },
  });

  const p = preview.data;
  const gone = preview.error instanceof ApiError && preview.error.status === 410;
  return (
    <AppShell title={<h1 className="font-display text-3xl leading-tight">Join a group</h1>}>
      <div className="max-w-md space-y-4">
        {preview.isPending && <Loading what="the invite" />}
        {gone && (
          <>
            <p className="text-lg">This invite link doesn’t work any more. It may have been used already or have expired.</p>
            <p className="text-muted">Ask whoever sent it for a new link.</p>
          </>
        )}
        {!gone && <ErrorNote error={preview.error} />}
        {p && (
          <>
            <p className="text-lg">
              {p.invitedBy} invited you to <span className="font-semibold">{p.groupName}</span>
              {p.ghostName && <> as <span className="font-semibold">{p.ghostName}</span></>}.
            </p>
            {p.ghostName && (
              <p className="text-muted">
                {p.alreadyMember
                  ? `You’re already in ${p.groupName}. Joining links ${p.ghostName}’s expenses to you, so they count as yours.`
                  : `Expenses already recorded for ${p.ghostName} become yours.`}
              </p>
            )}
            {!p.usable && <p className="font-medium">This link has already been used or has expired. Ask for a new one.</p>}
            {p.usable && p.alreadyMember && !p.ghostName ? (
              <Link to={`/groups/${p.groupId}`} className={btn.primary}>Open {p.groupName}</Link>
            ) : (
              p.usable && (
                <Button onClick={() => { accept.mutate(); }} disabled={accept.isPending}>
                  {p.ghostName ? `Join as ${p.ghostName}` : `Join ${p.groupName}`}
                </Button>
              )
            )}
            <ErrorNote error={accept.error} />
          </>
        )}
      </div>
    </AppShell>
  );
}
