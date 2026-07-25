import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { Button, Card, Field, Input, Pill, Select } from '../components/ui.tsx';
import { IconLogout } from '../components/icons.tsx';

export function Settings() {
  const { user, setUser } = useSession();
  const navigate = useNavigate();

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    navigate('/login');
  };

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Settings</h1>
      </header>

      <Card className="divide-y divide-border">
        <Row label="Email" value={user?.email ?? '—'} />
        <Row label="Username" value={user?.username ?? '—'} />
        {user?.isAdmin && <Row label="Role" value="Admin" />}
      </Card>

      <LlmSettings />

      <ArtworkSettings />

      <WatchRegionSettings />
      <TraktHideSettings />

      <ChangePassword />

      <div className="mt-8">
        <Button variant="secondary" onClick={logout}>
          <IconLogout /> Sign out
        </Button>
      </div>
    </div>
  );
}

interface AiStatus {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
}

const PRESETS: Record<string, string> = {
  OpenRouter: 'https://openrouter.ai/api/v1',
  'Local (Ollama)': 'http://localhost:11434/v1',
};

function LlmSettings() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<AiStatus>('/api/ai').then((s) => {
      setStatus(s);
      setBaseUrl(s.baseUrl ?? '');
      setModel(s.model ?? '');
    });
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const s = await api.put<AiStatus>('/api/ai', { baseUrl, model, apiKey });
      setStatus(s);
      setApiKey('');
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'err', text: err instanceof ApiError ? err.message : 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>('/api/ai/test');
      setMsg(
        r.ok
          ? { tone: 'ok', text: 'Connection works.' }
          : { tone: 'err', text: r.error ?? 'Test failed.' },
      );
    } catch (err) {
      setMsg({ tone: 'err', text: err instanceof ApiError ? err.message : 'Test failed.' });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    await api.del('/api/ai');
    setStatus({ configured: false, baseUrl: null, model: null });
    setBaseUrl('');
    setModel('');
    setApiKey('');
    setMsg(null);
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">AI recommendations</h2>
        {status?.configured ? (
          <Pill tone="success">Connected</Pill>
        ) : (
          <Pill tone="neutral">Optional</Pill>
        )}
      </div>
      <Card className="p-5">
        <p className="mb-4 text-xs text-faint">
          Bring your own OpenAI-compatible key (OpenRouter, or a local model) to enable smarter
          re-ranking and natural-language catalogs. Everything works without it.
        </p>
        <div className="space-y-4">
          <Field label="Base URL" hint="OpenAI-compatible endpoint.">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              className="font-mono text-xs"
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {Object.entries(PRESETS).map(([label, url]) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setBaseUrl(url)}
                  className="rounded-full bg-elevated px-2.5 py-0.5 text-xs text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Model">
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="anthropic/claude-3.5-haiku"
              className="font-mono text-xs"
            />
          </Field>
          <Field
            label="API key"
            hint={
              status?.configured
                ? 'Stored encrypted. Leave blank to keep the current key.'
                : 'Stored encrypted.'
            }
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
          </Field>
          {msg && (
            <p className={`text-sm ${msg.tone === 'ok' ? 'text-success' : 'text-danger'}`}>
              {msg.text}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={save}
              loading={busy}
              disabled={!baseUrl || !model || (!apiKey && !status?.configured)}
            >
              Save
            </Button>
            {status?.configured && (
              <>
                <Button variant="secondary" onClick={test} loading={busy}>
                  Test
                </Button>
                <Button variant="danger" onClick={clear}>
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}

interface WatchRegion {
  chosen: string | null;
  detected: string | null;
  effective: string | null;
}

interface RegionOption {
  code: string;
  name: string;
}

/**
 * Which country's streaming availability catalogs answer for. Detected from
 * where requests arrive so it works untouched, and overridable because a VPN or
 * a trip abroad makes that guess wrong.
 */
function WatchRegionSettings() {
  const [region, setRegion] = useState<WatchRegion | null>(null);
  const [options, setOptions] = useState<RegionOption[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<WatchRegion>('/api/watch/region').then(setRegion);
    void api
      .get<{ regions: RegionOption[] }>('/api/watch/regions')
      .then((r) => setOptions(r.regions))
      .catch(() => setOptions([]));
  }, []);

  async function save(code: string) {
    setBusy(true);
    setMsg(null);
    try {
      const next = await api.put<WatchRegion>('/api/watch/region', { region: code || null });
      setRegion(next);
      setMsg({
        tone: 'ok',
        text: code
          ? 'Saved. Availability now answers for this country.'
          : 'Following where your requests come from again.',
      });
    } catch (err) {
      setMsg({
        tone: 'err',
        text: err instanceof ApiError ? err.message : 'Could not save your country.',
      });
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (code: string | null) =>
    code ? (options.find((o) => o.code === code)?.name ?? code) : null;
  const effective = nameOf(region?.effective ?? null);

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">Streaming country</h2>
        {region?.chosen ? <Pill tone="success">Chosen</Pill> : <Pill tone="neutral">Detected</Pill>}
      </div>
      <Card className="p-5">
        <p className="mb-4 text-xs text-faint">
          Streaming availability differs by country, so catalogs that filter on where a title
          streams need to know yours. It is worked out from where your requests come from, which a
          VPN or a trip abroad will get wrong. Set it here to pin it.
        </p>
        <div className="space-y-4">
          <Field label="Country">
            <Select
              value={region?.chosen ?? ''}
              disabled={busy || options.length === 0}
              onChange={(e) => void save(e.target.value)}
            >
              <option value="">
                {region?.detected
                  ? `Follow where I connect from (${nameOf(region.detected)})`
                  : 'Follow where I connect from'}
              </option>
              {options.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-xs text-faint">
            {effective
              ? `Answering availability for ${effective}.`
              : 'No country known yet. Open Watchmuse in Stremio, or pick one above.'}
          </p>
          {options.length === 0 && (
            <p className="text-xs text-faint">
              This server has no TMDB key, so streaming availability is unavailable.
            </p>
          )}
          {msg && (
            <p className={`text-xs ${msg.tone === 'ok' ? 'text-success' : 'text-danger'}`}>
              {msg.text}
            </p>
          )}
          <p className="text-xs text-faint">Streaming availability data provided by JustWatch.</p>
        </div>
      </Card>
    </section>
  );
}

interface ArtworkStatus {
  configured: boolean;
  template: string | null;
}

const ARTWORK_PRESETS: Record<string, string> = {
  XRDB: 'https://extendedratings.com/poster/{id}.jpg',
  RatingPosterDB: 'https://api.ratingposterdb.com/YOUR-KEY/imdb/poster-default/{imdb}.jpg',
};

function ArtworkSettings() {
  const [status, setStatus] = useState<ArtworkStatus | null>(null);
  const [template, setTemplate] = useState('');
  const [sample, setSample] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<ArtworkStatus>('/api/artwork').then((s) => {
      setStatus(s);
      setTemplate(s.template ?? '');
    });
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    setSample(null);
    try {
      const s = await api.put<ArtworkStatus>('/api/artwork', { template });
      setStatus(s);
      setMsg({ tone: 'ok', text: 'Saved. New posters appear as Stremio refreshes your catalogs.' });
    } catch (err) {
      setMsg({ tone: 'err', text: err instanceof ApiError ? err.message : 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    setBusy(true);
    setMsg(null);
    setSample(null);
    try {
      const r = await api.post<{ ok: boolean; sample?: string; error?: string }>(
        '/api/artwork/test',
      );
      if (r.ok && r.sample) setSample(r.sample);
      else setMsg({ tone: 'err', text: r.error ?? 'Could not build a preview.' });
    } catch (err) {
      setMsg({
        tone: 'err',
        text: err instanceof ApiError ? err.message : 'Could not build a preview.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    await api.del('/api/artwork');
    setStatus({ configured: false, template: null });
    setTemplate('');
    setSample(null);
    setMsg(null);
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">Custom artwork</h2>
        {status?.configured ? (
          <Pill tone="success">Custom</Pill>
        ) : (
          <Pill tone="neutral">Optional</Pill>
        )}
      </div>
      <Card className="p-5">
        <p className="mb-4 text-xs text-faint">
          Show ratings on your catalog posters by pointing them at a poster service. XRDB needs no
          key and works as soon as you save it; RatingPosterDB needs your own key. Leave this blank
          for plain TMDB posters. Titles the template cannot key, such as one with no IMDb id, keep
          their TMDB poster.
        </p>
        <div className="space-y-4">
          <Field
            label="Poster URL template"
            hint="Placeholders: {id} (imdb id, tmdb: fallback), {imdb}, {tmdb}, {type}. HTTPS only."
          >
            <Input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="https://your-source/poster/{id}.jpg"
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {Object.entries(ARTWORK_PRESETS).map(([label, url]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setTemplate(url)}
                  className="rounded-full bg-elevated px-2.5 py-0.5 text-xs text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {msg && (
            <p className={`text-sm ${msg.tone === 'ok' ? 'text-success' : 'text-danger'}`}>
              {msg.text}
            </p>
          )}
          {sample && (
            <div className="flex items-center gap-3">
              <img
                src={sample}
                alt="Sample poster from your source"
                className="h-28 w-auto rounded-md border border-border bg-elevated"
                onError={() =>
                  setMsg({
                    tone: 'err',
                    text: 'Your source returned no image for the sample title. Check the URL.',
                  })
                }
              />
              <p className="text-xs text-faint">
                Sample poster for a known title. A broken image means the source or key is wrong.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={busy} disabled={!template}>
              Save
            </Button>
            {status?.configured && (
              <>
                <Button variant="secondary" onClick={preview} loading={busy}>
                  Preview
                </Button>
                <Button variant="danger" onClick={clear}>
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await api.post('/api/auth/password/change', { currentPassword: current, newPassword: next });
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-ink">Change password</h2>
      <Card className="p-5">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Current password">
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label="Confirm new password" error={error ?? undefined}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          {done && (
            <p className="rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
              Password updated. Other devices have been signed out.
            </p>
          )}
          <Button type="submit" loading={loading}>
            Update password
          </Button>
        </form>
      </Card>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}

/**
 * Whether dismissing a title should also hide it on Trakt.
 *
 * Off unless asked for: this edits an account the user owns somewhere else, and
 * the copy says plainly what it will do rather than leaving them to find out.
 */
function TraktHideSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<{ enabled: boolean }>('/api/catalogs/trakt-hides')
      .then((r) => setEnabled(r.enabled))
      .catch(() => setEnabled(false));
  }, []);

  async function toggle() {
    if (enabled === null) return;
    setBusy(true);
    try {
      const r = await api.put<{ enabled: boolean }>('/api/catalogs/trakt-hides', {
        enabled: !enabled,
      });
      setEnabled(r.enabled);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">Dismissals on Trakt</h2>
        {enabled ? <Pill tone="success">On</Pill> : <Pill tone="neutral">Off</Pill>}
      </div>
      <Card className="p-5">
        <div className="space-y-4">
          <p className="text-xs text-faint">
            Hiding a title here normally only affects Watchmuse. Turn this on and it is also hidden
            from Trakt's recommendations, so it stops being suggested in your other apps too. This
            writes to your Trakt account, so it stays off until you ask for it.
          </p>
          <Button variant="secondary" onClick={toggle} loading={busy} disabled={enabled === null}>
            {enabled ? 'Stop hiding on Trakt' : 'Also hide on Trakt'}
          </Button>
        </div>
      </Card>
    </section>
  );
}
