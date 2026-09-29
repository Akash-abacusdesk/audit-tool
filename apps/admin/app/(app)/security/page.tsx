'use client';

import { useState } from 'react';
import { apiFetch, ApiRequestError } from '../../../lib/api';
import { PageHeader } from '../../../components/PageHeader';

type Enrollment = { secret: string; otpauthUri: string };

/**
 * Privileged step-up and authenticator (TOTP) enrollment. The admin plane needs a fresh step-up; once an
 * authenticator is confirmed, step-up also needs a 6-digit code (or a one-time recovery code).
 */
export default function SecurityPage() {
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // step-up
  const [su, setSu] = useState({ password: '', code: '', recoveryCode: '' });
  // enrollment
  const [password, setPassword] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // disable
  const [dis, setDis] = useState({ password: '', code: '', recoveryCode: '' });

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof ApiRequestError ? e.message : `${label} failed` });
    } finally {
      setBusy(false);
    }
  }

  const stepUp = (e: React.FormEvent) => {
    e.preventDefault();
    void run('step-up', async () => {
      const body: Record<string, string> = { password: su.password };
      if (su.code) body.code = su.code;
      if (su.recoveryCode) body.recoveryCode = su.recoveryCode;
      await apiFetch('/auth/step-up', { method: 'POST', body });
      setSu({ password: '', code: '', recoveryCode: '' });
      setMessage({ kind: 'ok', text: 'Step-up granted. Privileged actions are unlocked for a short time.' });
    });
  };

  const enroll = (e: React.FormEvent) => {
    e.preventDefault();
    void run('enroll', async () => {
      setEnrollment(await apiFetch<Enrollment>('/auth/mfa/enroll', { method: 'POST', body: { password } }));
      setPassword('');
      setRecoveryCodes(null);
    });
  };

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    void run('confirm', async () => {
      const r = await apiFetch<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { method: 'POST', body: { code: confirmCode } });
      setRecoveryCodes(r.recoveryCodes);
      setEnrollment(null);
      setConfirmCode('');
      setMessage({ kind: 'ok', text: 'Authenticator enabled. Save the recovery codes now - they are shown once.' });
    });
  };

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    void run('disable', async () => {
      const body: Record<string, string> = { password: dis.password };
      if (dis.code) body.code = dis.code;
      if (dis.recoveryCode) body.recoveryCode = dis.recoveryCode;
      await apiFetch('/auth/mfa/disable', { method: 'POST', body });
      setDis({ password: '', code: '', recoveryCode: '' });
      setMessage({ kind: 'ok', text: 'Authenticator disabled.' });
    });
  };

  return (
    <div>
      <PageHeader title="Security" subtitle="Step-up access and authenticator app (two-factor) for privileged actions." />
      {message && (
        <p
          className={`mb-4 max-w-4xl rounded-lg px-3 py-2 text-sm ${
            message.kind === 'ok'
              ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
              : 'bg-[var(--color-critical)]/10 text-[var(--color-critical)]'
          }`}
        >
          {message.text}
        </p>
      )}

      <div className="grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-2">
        <form onSubmit={stepUp} className="surface h-fit p-5">
          <h2 className="mb-4 text-sm font-semibold">Step up</h2>
          <label className="label mb-1.5 block">Password</label>
          <input className="input mb-3.5" type="password" autoComplete="current-password" value={su.password} onChange={(e) => setSu((s) => ({ ...s, password: e.target.value }))} required />
          <label className="label mb-1.5 block">Authenticator code (if enabled)</label>
          <input className="input mb-3.5" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={su.code} onChange={(e) => setSu((s) => ({ ...s, code: e.target.value }))} />
          <label className="label mb-1.5 block">or recovery code</label>
          <input className="input mb-5" value={su.recoveryCode} onChange={(e) => setSu((s) => ({ ...s, recoveryCode: e.target.value }))} />
          <button className="btn-primary w-full" disabled={busy}>Step up</button>
        </form>

        <div className="space-y-6">
          {!enrollment && !recoveryCodes && (
            <form onSubmit={enroll} className="surface h-fit p-5">
              <h2 className="mb-4 text-sm font-semibold">Enable authenticator app</h2>
              <label className="label mb-1.5 block">Password</label>
              <input className="input mb-5" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button className="btn-primary w-full" disabled={busy}>Start enrollment</button>
            </form>
          )}

          {enrollment && (
            <form onSubmit={confirm} className="surface h-fit p-5">
              <h2 className="mb-2 text-sm font-semibold">Add to your authenticator</h2>
              <p className="mb-2 text-xs text-[var(--color-text-dim)]">
                Enter this key in your authenticator app (time-based, 6 digits), then type the code it shows.
              </p>
              <code className="mb-3 block break-all rounded bg-black/30 p-2 text-xs">{enrollment.secret}</code>
              <a className="mb-4 block break-all text-xs underline" href={enrollment.otpauthUri}>Open in authenticator (otpauth link)</a>
              <label className="label mb-1.5 block">Code</label>
              <input className="input mb-5" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} required />
              <button className="btn-primary w-full" disabled={busy}>Confirm and enable</button>
            </form>
          )}

          {recoveryCodes && (
            <div className="surface h-fit p-5">
              <h2 className="mb-2 text-sm font-semibold">Recovery codes</h2>
              <p className="mb-3 text-xs text-[var(--color-text-dim)]">Each works once if you lose your device. They will not be shown again.</p>
              <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                {recoveryCodes.map((c) => (
                  <code key={c} className="rounded bg-black/30 px-2 py-1">{c}</code>
                ))}
              </div>
              <button className="btn-ghost mt-4 w-full" onClick={() => setRecoveryCodes(null)}>I saved them</button>
            </div>
          )}

          <form onSubmit={disable} className="surface h-fit p-5">
            <h2 className="mb-4 text-sm font-semibold">Disable authenticator</h2>
            <label className="label mb-1.5 block">Password</label>
            <input className="input mb-3.5" type="password" autoComplete="current-password" value={dis.password} onChange={(e) => setDis((s) => ({ ...s, password: e.target.value }))} required />
            <label className="label mb-1.5 block">Authenticator code</label>
            <input className="input mb-3.5" inputMode="numeric" maxLength={6} value={dis.code} onChange={(e) => setDis((s) => ({ ...s, code: e.target.value }))} />
            <label className="label mb-1.5 block">or recovery code</label>
            <input className="input mb-5" value={dis.recoveryCode} onChange={(e) => setDis((s) => ({ ...s, recoveryCode: e.target.value }))} />
            <button className="btn-danger w-full" disabled={busy}>Disable</button>
          </form>
        </div>
      </div>
    </div>
  );
}
