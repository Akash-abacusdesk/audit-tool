'use client';

import { useState } from 'react';
import { Copy, Fingerprint, LockKeyOpen } from '@phosphor-icons/react';
import { apiFetch } from '../../../lib/api';
import { errMsg } from '../../../lib/useApi';
import { Button, Field, Input, PageHeader, Panel, RevealGroup, RevealItem, useToast } from '../../../components/ui';

type Enrollment = { secret: string; otpauthUri: string };
const codeInput = 'font-mono tracking-[0.3em]';

/**
 * Privileged step-up and authenticator (TOTP) enrollment. The admin plane needs a fresh step-up; once an
 * authenticator is confirmed, step-up also needs a 6-digit code (or a one-time recovery code).
 */
export default function SecurityPage() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [su, setSu] = useState({ password: '', code: '', recoveryCode: '' });
  const [password, setPassword] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [dis, setDis] = useState({ password: '', code: '', recoveryCode: '' });

  async function run(key: string, fn: () => Promise<void>, fallback: string) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(errMsg(e, fallback));
    } finally {
      setBusy(null);
    }
  }
  const optional = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

  return (
    <div>
      <PageHeader title="Account security" description="Unlock privileged actions and protect your account with an authenticator app." />
      <RevealGroup className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-2">
        <RevealItem>
          <Panel>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run('stepup', async () => {
                  await apiFetch('/auth/step-up', { method: 'POST', body: optional(su), noStepUp: true });
                  setSu({ password: '', code: '', recoveryCode: '' });
                  toast.success('Unlocked. Privileged actions are available for a few minutes.');
                }, 'Could not unlock.');
              }}
            >
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Unlock privileged actions</h2>
                <p className="mt-0.5 text-xs leading-5 text-ink-faint">Managing sites, the team and production needs a recent confirmation.</p>
              </div>
              <Field label="Password" htmlFor="su-pass"><Input id="su-pass" type="password" autoComplete="current-password" value={su.password} onChange={(e) => setSu((s) => ({ ...s, password: e.target.value }))} required /></Field>
              <Field label="Authenticator code" htmlFor="su-code" hint="Only if an authenticator is turned on."><Input id="su-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={codeInput} value={su.code} onChange={(e) => setSu((s) => ({ ...s, code: e.target.value }))} /></Field>
              <Field label="Recovery code" htmlFor="su-rec" hint="Use one if you lost your device."><Input id="su-rec" className="font-mono" value={su.recoveryCode} onChange={(e) => setSu((s) => ({ ...s, recoveryCode: e.target.value }))} /></Field>
              <Button type="submit" variant="primary" icon={<LockKeyOpen size={16} />} loading={busy === 'stepup'} className="mt-1">Unlock</Button>
            </form>
          </Panel>
        </RevealItem>

        <RevealItem className="flex flex-col gap-4">
          {!enrollment && !recoveryCodes && (
            <Panel>
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('enroll', async () => {
                    setEnrollment(await apiFetch<Enrollment>('/auth/mfa/enroll', { method: 'POST', body: { password } }));
                    setPassword('');
                  }, 'Could not start enrollment.');
                }}
              >
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Authenticator app</h2>
                  <p className="mt-0.5 text-xs leading-5 text-ink-faint">Adds a six-digit code to every unlock, so a stolen password is not enough.</p>
                </div>
                <Field label="Password" htmlFor="en-pass"><Input id="en-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
                <Button type="submit" variant="secondary" icon={<Fingerprint size={16} />} loading={busy === 'enroll'}>Start setup</Button>
              </form>
            </Panel>
          )}

          {enrollment && (
            <Panel>
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('confirm', async () => {
                    const r = await apiFetch<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { method: 'POST', body: { code: confirmCode } });
                    setRecoveryCodes(r.recoveryCodes);
                    setEnrollment(null);
                    setConfirmCode('');
                    toast.success('Authenticator is on. Save your recovery codes now.');
                  }, 'That code did not match.');
                }}
              >
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Add it to your app</h2>
                  <p className="mt-0.5 text-xs leading-5 text-ink-faint">Enter this key in your authenticator (time-based, 6 digits), then type the code it shows.</p>
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-[10px] bg-sunken px-3.5 py-2.5 font-mono text-[13px] text-accent ring-1 ring-inset ring-line">{enrollment.secret}</code>
                  <Button type="button" variant="secondary" icon={<Copy size={16} />} onClick={() => navigator.clipboard.writeText(enrollment.secret).then(() => toast.success('Key copied.'))}>Copy</Button>
                </div>
                <Field label="Code" htmlFor="cf-code"><Input id="cf-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={codeInput} value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} required /></Field>
                <Button type="submit" variant="primary" loading={busy === 'confirm'}>Confirm and turn on</Button>
              </form>
            </Panel>
          )}

          {recoveryCodes && (
            <Panel>
              <h2 className="text-sm font-semibold tracking-tight">Recovery codes</h2>
              <p className="mb-4 mt-0.5 text-xs leading-5 text-ink-faint">Each works once if you lose your device. They are not shown again.</p>
              <div className="grid grid-cols-2 gap-2">
                {recoveryCodes.map((c) => (
                  <code key={c} className="rounded-[10px] bg-sunken px-3 py-2 text-center font-mono text-[13px] ring-1 ring-inset ring-line">{c}</code>
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <Button variant="secondary" icon={<Copy size={16} />} onClick={() => navigator.clipboard.writeText(recoveryCodes.join('\n')).then(() => toast.success('Codes copied.'))}>Copy all</Button>
                <Button variant="ghost" onClick={() => setRecoveryCodes(null)}>I saved them</Button>
              </div>
            </Panel>
          )}

          <Panel>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run('disable', async () => {
                  await apiFetch('/auth/mfa/disable', { method: 'POST', body: optional(dis), noStepUp: true });
                  setDis({ password: '', code: '', recoveryCode: '' });
                  toast.success('Authenticator turned off.');
                }, 'Could not turn it off.');
              }}
            >
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Turn off authenticator</h2>
                <p className="mt-0.5 text-xs leading-5 text-ink-faint">Needs your password and a current code or recovery code.</p>
              </div>
              <Field label="Password" htmlFor="di-pass"><Input id="di-pass" type="password" autoComplete="current-password" value={dis.password} onChange={(e) => setDis((s) => ({ ...s, password: e.target.value }))} required /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Code" htmlFor="di-code"><Input id="di-code" inputMode="numeric" maxLength={6} className={codeInput} value={dis.code} onChange={(e) => setDis((s) => ({ ...s, code: e.target.value }))} /></Field>
                <Field label="Or recovery code" htmlFor="di-rec"><Input id="di-rec" className="font-mono" value={dis.recoveryCode} onChange={(e) => setDis((s) => ({ ...s, recoveryCode: e.target.value }))} /></Field>
              </div>
              <Button type="submit" variant="danger" loading={busy === 'disable'}>Turn off</Button>
            </form>
          </Panel>
        </RevealItem>
      </RevealGroup>
    </div>
  );
}
