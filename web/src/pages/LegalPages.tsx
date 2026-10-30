import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { LegalLinks } from '../components/ui';

// The public privacy policy and terms (/privacy, /terms): linked from sign-in, the account page
// and Google's consent screen. Only what the code really does: each statement has a source in
// api/, db/migrations/ or deploy/. Change them together.
const CONTACT_EMAIL = 'privacy@dhruvgoyal.tech';
const UPDATED = '30 October 2026';
const link = 'underline underline-offset-2';

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="stitch bg-band px-4 pb-8 pt-10 text-band-ink">
        <div className="mx-auto max-w-2xl">
          <Link to="/" className="font-display text-2xl">Hisaab</Link>
          <h1 className="mt-3 font-display text-4xl leading-none">{title}</h1>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-8 [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-2xl [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
        <p className="text-sm text-muted">Last updated {UPDATED}</p>
        {children}
        <p className="border-t border-rule pt-4 text-sm">
          Questions or requests: <a href={`mailto:${CONTACT_EMAIL}`} className={link}>{CONTACT_EMAIL}</a>
        </p>
        <LegalLinks />
      </main>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <Page title="Privacy">
      <p>
        Hisaab is a group expense-sharing app run as a personal project by Dhruv Goyal. This page says what it keeps
        about you, where, for how long, and how to remove it.
      </p>

      <h2>What it keeps</h2>
      <ul>
        <li><strong>From Google or GitHub, when you sign in:</strong> your name, your verified email address and the account id that provider gives you. Never your password.</li>
        <li><strong>What you and your friends enter:</strong> groups, the names of members (including friends added before they sign up), expenses, notes on them, splits and settlements.</li>
        <li><strong>To keep you signed in:</strong> one cookie, valid for 7 days. The server stores only a hash of it, with your browser’s user-agent string.</li>
        <li><strong>To keep the service running:</strong> server logs, which include IP addresses, and short-lived rate-limit counters keyed by IP address or account.</li>
      </ul>

      <h2>What it doesn’t do</h2>
      <p>
        No ads, no analytics, no tracking scripts, and no third-party code in the page. Your data is not sold or shared
        for marketing. Hisaab sends no email. It only records who owes what: it never touches real money or bank details.
      </p>

      <h2>Who can see it</h2>
      <ul>
        <li>Everyone in a group sees that group’s members, expenses, balances and history.</li>
        <li>Data is encrypted on its way to the server (HTTPS) and backups are encrypted, but the database itself is readable by whoever runs the server. That is Dhruv alone.</li>
        <li>Hisaab runs on a Microsoft Azure server in Malaysia. Encrypted backups are stored with Microsoft Azure and Cloudflare. Google and GitHub handle sign-in under their own privacy policies.</li>
      </ul>

      <h2>How long it stays, and deleting it</h2>
      <p>Your data stays until you delete your account, which you can do yourself from the account page, at once.</p>
      <ul>
        <li>Your email address, sign-ins and sessions are removed, and your name on the account becomes “Deleted user”.</li>
        <li>Your groups keep their expenses and balances, because your friends’ totals depend on them. Your place in each group becomes “Deleted user”.</li>
        <li>A group’s history can’t be edited, so older entries may still show the name you had in that group.</li>
        <li>Backups are deleted after 35 days. Until then a deleted account can remain in them.</li>
      </ul>
      <p>To ask for a copy of your data, or for anything the account page doesn’t do, write to the address below.</p>
    </Page>
  );
}

export function TermsPage() {
  return (
    <Page title="Terms">
      <p>By using Hisaab you agree to the following. It is a free personal project run by Dhruv Goyal, not a company.</p>

      <h2>What Hisaab is</h2>
      <p>
        A shared notebook for group expenses. It works out who owes whom, but moves no money, and it isn’t a bank,
        a payment service or financial advice. Settling up happens between you and your friends, outside the app.
      </p>

      <h2>No guarantee</h2>
      <p>
        Hisaab is provided as it is, without warranty. It is often switched off between uses, and it may change or
        stop at any time. Keep your own record of anything that matters. To the extent the law allows, the operator is
        not liable for losses from using it, including wrong entries or lost data.
      </p>

      <h2>Your part</h2>
      <ul>
        <li>What you enter is your responsibility, including names of friends who haven’t signed up.</li>
        <li>Don’t use it to break the law, harass anyone, or attack or overload the service.</li>
        <li>Anyone with an invite link can join that group until the link expires, so share it only with the people you mean to.</li>
      </ul>

      <h2>Ending</h2>
      <p>
        You can delete your account at any time from the account page. An account that abuses the service may be
        disabled. <Link to="/privacy" className={link}>The privacy page</Link> says what happens to your data.
      </p>

      <h2>Changes</h2>
      <p>These terms may change. The date at the top shows the latest version.</p>
    </Page>
  );
}
