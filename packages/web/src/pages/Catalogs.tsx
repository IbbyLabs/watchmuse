import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';
import {
  genreNames,
  genresForMediaType,
  remapGenresForMediaType,
  type Catalog,
  type CatalogDiagnosis,
  type CatalogMediaType,
  type CatalogPreview,
  type CatalogSort,
  type ConstraintReport,
  type CatalogType,
  type InstallInfo,
  type PreviewItem,
  type WatchService,
} from '../lib/types.ts';
import { Button, Card, Field, Input, Modal, Pill, Select, Spinner } from '../components/ui.tsx';
import {
  IconEye,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from '../components/icons.tsx';

const MEDIA_LABEL: Record<CatalogMediaType, string> = {
  movie: 'Movies',
  series: 'Series',
  both: 'Movies & Series',
};

/** One-line description of a catalog for its list row: media, genres, rating, services. */
function catalogSummary(cat: Catalog): string {
  const parts: string[] = [MEDIA_LABEL[cat.mediaType]];
  if (cat.type === 'nl') parts.push('described with AI');
  if (cat.type === 'rewatch') parts.push('watched over two years ago');
  if (cat.type === 'newseason') parts.push('a season you have not seen');
  const names = cat.filter?.genres ? genreNames(cat.filter.genres) : [];
  if (names.length)
    parts.push(names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''));
  if (cat.filter?.minRating) parts.push(`${cat.filter.minRating}+ rating`);
  const services = cat.filter?.providers?.length ?? 0;
  if (services) parts.push(services === 1 ? '1 service' : `${services} services`);
  return parts.join(' · ');
}

export function Catalogs() {
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [install, setInstall] = useState<InstallInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Catalog | null>(null);
  const [viewing, setViewing] = useState<Catalog | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [reinstallHint, setReinstallHint] = useState(false);

  async function load() {
    const [cats, inst] = await Promise.all([
      api.get<Catalog[]>('/api/catalogs'),
      api.get<InstallInfo>('/api/catalogs/install'),
    ]);
    setCatalogs(cats);
    setInstall(inst);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(cat: Catalog) {
    const updated = await api.patch<Catalog>(`/api/catalogs/${cat.id}`, { enabled: !cat.enabled });
    setCatalogs((cs) => cs.map((c) => (c.id === cat.id ? updated : c)));
    setReinstallHint(true);
  }

  async function remove(id: string) {
    await api.del(`/api/catalogs/${id}`);
    setCatalogs((cs) => cs.filter((c) => c.id !== id));
    setConfirmDelete(null);
    setReinstallHint(true);
  }

  async function copyUrl() {
    if (!install) return;
    await navigator.clipboard.writeText(install.manifestUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function refresh() {
    await api.post('/api/catalogs/refresh');
    setRefreshed(true);
    setTimeout(() => setRefreshed(false), 2500);
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-20 text-muted">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink">Catalogs</h1>
        <Button onClick={() => setCreating(true)}>
          <IconPlus className="text-base" /> New catalog
        </Button>
      </div>

      {install && (
        <Card className="p-5">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Add to Stremio</h2>
              <p className="text-xs text-faint">
                Install this URL in Stremio to get your catalogs as home-screen rows.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                readOnly
                value={install.manifestUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button variant="secondary" onClick={copyUrl}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <a
                  href={install.stremioUrl}
                  className="inline-flex min-h-[40px] items-center justify-center rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  Open in Stremio
                </a>
              </div>
            </div>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1.5 rounded text-xs text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <IconRefresh className="text-sm" />{' '}
              {refreshed ? 'Refreshing recommendations…' : 'Refresh recommendations'}
            </button>
            {reinstallHint && (
              <div className="flex items-start justify-between gap-3 rounded-lg bg-brand/10 px-3 py-2 text-xs text-ink">
                <span>
                  Added or removed a catalog? Re-add this URL in Stremio (same link) to see the new
                  rows. Edits to a catalog's filters show up on their own.
                </span>
                <button
                  onClick={() => setReinstallHint(false)}
                  className="shrink-0 text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  aria-label="Dismiss"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        </Card>
      )}

      <ShareSetup onImported={() => void load()} />

      <div className="space-y-2">
        {catalogs.length === 0 ? (
          <Card className="p-6">
            <p className="text-center text-sm text-muted">
              No catalogs yet. Create one to build your first row.
            </p>
          </Card>
        ) : (
          catalogs.map((cat) => (
            <Card key={cat.id} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink">{cat.name}</span>
                    {!cat.enabled && <Pill tone="neutral">Disabled</Pill>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-faint">{catalogSummary(cat)}</p>
                </div>
                {confirmDelete === cat.id ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted">Delete this catalog?</span>
                    <Button variant="danger" onClick={() => remove(cat.id)}>
                      Delete
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setViewing(cat)}
                      title="View"
                      aria-label={`View ${cat.name}`}
                    >
                      <IconEye className="text-base" />
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setEditing(cat)}
                      title="Edit"
                      aria-label={`Edit ${cat.name}`}
                    >
                      <IconPencil className="text-base" />
                    </Button>
                    <Button variant="secondary" onClick={() => toggle(cat)}>
                      {cat.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => setConfirmDelete(cat.id)}
                      title="Delete"
                      aria-label={`Delete ${cat.name}`}
                    >
                      <IconTrash className="text-base" />
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))
        )}
      </div>

      {creating && (
        <CatalogForm
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            setCatalogs((cs) => [...cs, c]);
            setCreating(false);
            setReinstallHint(true);
          }}
        />
      )}
      {editing && (
        <CatalogForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setCatalogs((cs) => cs.map((x) => (x.id === c.id ? c : x)));
            setEditing(null);
            setReinstallHint(true);
          }}
        />
      )}
      {viewing && <CatalogViewer catalog={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

const MODES = ['filter', 'nl', 'rewatch', 'newseason'] as const;

const MODE_LABEL: Record<CatalogType, string> = {
  filter: 'Filters',
  nl: 'Describe it',
  rewatch: 'Watch again',
  newseason: 'New seasons',
};

const MODE_HINT: Record<'rewatch' | 'newseason', string> = {
  rewatch:
    'Titles you watched more than two years ago, with the ones you rated highest first. Needs watch dates, which Simkl and MDBList do not provide.',
  newseason:
    'Shows you watch that have a season you have not seen. Exact where your service reports episodes; otherwise it falls back to shows still running.',
};

function CatalogForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Catalog;
  onClose: () => void;
  onSaved: (c: Catalog) => void;
}) {
  const [mode, setMode] = useState<CatalogType>(initial?.type ?? 'filter');
  const [name, setName] = useState(initial?.name ?? '');
  const [mediaType, setMediaType] = useState<CatalogMediaType>(initial?.mediaType ?? 'both');
  const [genres, setGenres] = useState<number[]>(initial?.filter?.genres ?? []);
  const [minRating, setMinRating] = useState(
    initial?.filter?.minRating != null ? String(initial.filter.minRating) : '',
  );
  const [yearMin, setYearMin] = useState(
    initial?.filter?.yearMin != null ? String(initial.filter.yearMin) : '',
  );
  const [sort, setSort] = useState<CatalogSort>(initial?.filter?.sort ?? 'score');
  const [providers, setProviders] = useState<number[]>(initial?.filter?.providers ?? []);
  const [services, setServices] = useState<WatchService[] | null>(null);
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function toggleGenre(id: number) {
    setGenres((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));
  }

  function toggleProvider(id: number) {
    setProviders((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  // Services depend on the country, so an unset country means no list to offer.
  useEffect(() => {
    const type = mediaType === 'series' ? 'series' : 'movie';
    void api
      .get<{ providers: WatchService[] }>(`/api/watch/providers?type=${type}`)
      .then((r) => setServices(r.providers))
      .catch(() => setServices([]));
  }, [mediaType]);

  function changeMediaType(next: CatalogMediaType) {
    setMediaType(next);
    setGenres((g) => remapGenresForMediaType(g, next));
  }

  async function submit() {
    if (!name.trim()) {
      setError('Give the catalog a name.');
      return;
    }
    if (mode === 'nl' && !prompt.trim()) {
      setError('Describe what this catalog should contain.');
      return;
    }
    setSaving(true);
    setError('');
    const body =
      mode === 'nl'
        ? { name: name.trim(), type: 'nl' as const, mediaType, prompt: prompt.trim() }
        : mode === 'rewatch' || mode === 'newseason'
          ? { name: name.trim(), type: mode, mediaType }
          : (() => {
            const filter: Catalog['filter'] = { sort };
            if (genres.length) filter.genres = genres;
            if (minRating) filter.minRating = Number(minRating);
            if (yearMin) filter.yearMin = Number(yearMin);
            if (providers.length) filter.providers = providers;
            return { name: name.trim(), mediaType, filter };
            })();
    try {
      const saved = initial
        ? await api.patch<Catalog>(`/api/catalogs/${initial.id}`, body)
        : await api.post<Catalog>('/api/catalogs', body);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save catalog.');
      setSaving(false);
    }
  }

  return (
    <Modal title={initial ? 'Edit catalog' : 'New catalog'} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-elevated p-1 sm:grid-cols-4">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                mode === m ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
              }`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>

        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sci-Fi I haven't seen"
            autoFocus
          />
        </Field>
        <Field label="Include">
          <Select
            value={mediaType}
            onChange={(e) => changeMediaType(e.target.value as CatalogMediaType)}
          >
            <option value="both">Movies & Series</option>
            <option value="movie">Movies only</option>
            <option value="series">Series only</option>
          </Select>
        </Field>

        {mode === 'rewatch' || mode === 'newseason' ? (
          <p className="rounded-lg bg-elevated px-3 py-2 text-xs text-muted">
            {MODE_HINT[mode as 'rewatch' | 'newseason']}
          </p>
        ) : mode === 'nl' ? (
          <Field
            label="Describe this catalog"
            hint="Needs an AI key (Settings). Without one it falls back to your top picks."
          >
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Cozy sci-fi like my recent favourites, but lighter"
              className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-ink transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40"
            />
          </Field>
        ) : (
          <>
            <Field label="Genres" hint="Optional — match any selected genre.">
              <div className="flex flex-wrap gap-1.5">
                {genresForMediaType(mediaType).map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleGenre(g.id)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
                      genres.includes(g.id)
                        ? 'bg-brand text-white'
                        : 'bg-elevated text-muted hover:text-ink'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Min rating" hint="0–10">
                <Input
                  type="number"
                  min="0"
                  max="10"
                  step="0.5"
                  value={minRating}
                  onChange={(e) => setMinRating(e.target.value)}
                  placeholder="7"
                />
              </Field>
              <Field label="From year">
                <Input
                  type="number"
                  value={yearMin}
                  onChange={(e) => setYearMin(e.target.value)}
                  placeholder="2015"
                />
              </Field>
            </div>
            <Field
              label="Streaming on"
              hint="Optional — show only titles streaming on these. Leave empty to ignore availability."
            >
              {services === null ? (
                <p className="text-xs text-faint">Loading services…</p>
              ) : services.length === 0 ? (
                <p className="text-xs text-faint">
                  Set your streaming country in Settings to filter by service.
                </p>
              ) : (
                <>
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                    {services.map((sv) => (
                      <button
                        key={sv.id}
                        type="button"
                        onClick={() => toggleProvider(sv.id)}
                        aria-pressed={providers.includes(sv.id)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
                          providers.includes(sv.id)
                            ? 'bg-brand text-white'
                            : 'bg-elevated text-muted hover:text-ink'
                        }`}
                      >
                        {sv.name}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-faint">
                    Streaming availability data provided by JustWatch.
                  </p>
                </>
              )}
            </Field>
            <Field label="Sort by">
              <Select value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)}>
                <option value="score">Best match</option>
                <option value="rating">Rating</option>
                <option value="popularity">Popularity</option>
                <option value="year">Newest</option>
              </Select>
            </Field>
          </>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            {initial ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const MEDIA_NOUN: Record<CatalogMediaType, string> = {
  movie: 'movies',
  series: 'series',
  both: 'titles',
};

/** One poster with its title, year, and a corner action (hide or restore). */
function PosterTile({
  item,
  dimmed,
  action,
}: {
  item: PreviewItem;
  dimmed?: boolean;
  action: ReactNode;
}) {
  return (
    <li className="relative">
      <div
        className={`aspect-[2/3] overflow-hidden rounded-lg border border-border bg-elevated ${dimmed ? 'opacity-50' : ''}`}
      >
        {item.poster ? (
          <img src={item.poster} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center p-2 text-center text-[11px] text-faint">
            {item.title}
          </div>
        )}
      </div>
      {action}
      <p className="mt-1 truncate text-xs text-ink" title={item.title}>
        {item.title}
      </p>
      {item.year != null && <p className="text-[11px] text-faint">{item.year}</p>}
    </li>
  );
}

const cornerBtn =
  'absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

const CONSTRAINT_LABEL: Record<ConstraintReport['key'], string> = {
  mediaType: 'the media type',
  genres: 'the genre filter',
  years: 'the year range',
  minRating: 'the rating floor',
  providers: 'the streaming service filter',
  sources: 'the source restriction',
};

/** Under this many titles a row looks broken, so it is worth explaining. */
const THIN_ROW = 10;

/**
 * Says why a catalog is short. Recommendations come from what you have watched,
 * so a filter for something outside that will stay thin no matter how many
 * times you rebuild — worth saying plainly rather than leaving a gap.
 *
 * It reports what each filter costs rather than recommending one to drop: the
 * filter with the largest gain is often the whole point of the catalog, and
 * "loosen the genre" is useless advice on a catalog called Documentaries. Which
 * filter is negotiable is the reader's call.
 */
function ThinCatalogNote({ diagnosis }: { diagnosis: CatalogDiagnosis }) {
  const { matched, constraints } = diagnosis;
  if (matched >= THIN_ROW) return null;

  const options = constraints.filter((c) => c.withoutThis > matched).slice(0, 2);

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
      <p className="text-ink">
        {matched === 0
          ? 'Nothing in your recommendations matches these filters.'
          : `Only ${matched} ${matched === 1 ? 'title matches' : 'titles match'} these filters.`}
      </p>
      {options.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {options.map((c) => (
            <li key={c.key}>
              Without {CONSTRAINT_LABEL[c.key]}:{' '}
              <span className="text-ink">
                {c.withoutThis} {c.withoutThis === 1 ? 'title' : 'titles'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5">
        Picks come from what you have watched, so a filter for something outside your history stays
        thin however often you rebuild.
      </p>
    </div>
  );
}

function CatalogViewer({ catalog, onClose }: { catalog: Catalog; onClose: () => void }) {
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [note, setNote] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  async function loadPreview() {
    const p = await api.get<CatalogPreview>(`/api/catalogs/${catalog.id}/preview`);
    setPreview(p);
  }

  useEffect(() => {
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.id]);

  async function hide(item: PreviewItem) {
    // Drop it immediately; refetch pulls the next-best match into the freed slot.
    setPreview((p) =>
      p
        ? { ...p, items: p.items.filter((i) => i.tmdbId !== item.tmdbId || i.type !== item.type) }
        : p,
    );
    await api.post(`/api/catalogs/${catalog.id}/hide`, { tmdbId: item.tmdbId, type: item.type });
    await loadPreview();
  }

  async function unhide(item: PreviewItem) {
    setPreview((p) =>
      p
        ? { ...p, hidden: p.hidden.filter((i) => i.tmdbId !== item.tmdbId || i.type !== item.type) }
        : p,
    );
    await api.post(`/api/catalogs/${catalog.id}/unhide`, { tmdbId: item.tmdbId, type: item.type });
    await loadPreview();
  }

  // Rebuilds the whole recommendation pool from your latest history (hits TMDB, so it's rate-limited).
  async function rebuild() {
    setRebuilding(true);
    setNote('');
    try {
      await api.post('/api/catalogs/refresh');
      setNote('rebuilding');
    } catch (err) {
      setNote(err instanceof ApiError && err.status === 429 ? 'ratelimited' : 'error');
    } finally {
      setRebuilding(false);
    }
  }

  const items = preview?.items ?? [];
  const hidden = preview?.hidden ?? [];
  const building = preview?.status === 'building';

  return (
    <Modal title={catalog.name} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-faint">
            {building
              ? 'Building your recommendations…'
              : `${items.length} ${MEDIA_NOUN[catalog.mediaType]}${items.length ? ' · hide any you are not into and the next pick fills in' : ''}`}
          </p>
          <Button
            variant="secondary"
            onClick={rebuild}
            loading={rebuilding}
            title="Rebuild recommendations from your latest history"
          >
            <IconRefresh className="text-base" /> Rebuild
          </Button>
        </div>

        {note && (
          <p className="rounded-lg bg-brand/10 px-3 py-2 text-xs text-ink">
            {note === 'rebuilding' ? (
              <>
                Rebuilding from your latest history. This takes a moment.{' '}
                <button
                  onClick={loadPreview}
                  className="font-medium text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Reload
                </button>{' '}
                once it is done.
              </>
            ) : note === 'ratelimited' ? (
              'You have rebuilt a few times recently. Give it a little while before trying again.'
            ) : (
              'Could not rebuild right now. Try again in a moment.'
            )}
          </p>
        )}

        {!building && preview?.diagnosis && <ThinCatalogNote diagnosis={preview.diagnosis} />}

        {preview === null || building ? (
          <div className="grid place-items-center py-16 text-muted">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          // With a diagnosis above, the note already explains it; a second
          // "nothing here" line underneath would just repeat itself.
          preview.diagnosis ? null : (
            <p className="py-10 text-center text-sm text-muted">
              Nothing here yet. Loosen the filters, or rebuild to refresh your recommendations.
            </p>
          )
        ) : (
          <ul className="grid max-h-[62vh] grid-cols-3 gap-3 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-5">
            {items.map((item) => (
              <PosterTile
                key={`${item.type}:${item.tmdbId}`}
                item={item}
                action={
                  <button
                    type="button"
                    onClick={() => hide(item)}
                    title="Hide"
                    aria-label={`Hide ${item.title}`}
                    className={cornerBtn}
                  >
                    <IconX className="text-sm" />
                  </button>
                }
              />
            ))}
          </ul>
        )}

        {hidden.length > 0 && (
          <div className="border-t border-border pt-3">
            <button
              onClick={() => setShowHidden((s) => !s)}
              aria-expanded={showHidden}
              className="text-xs font-medium text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {showHidden ? 'Hide' : 'Show'} hidden ({hidden.length})
            </button>
            {showHidden && (
              <ul className="mt-3 grid max-h-[40vh] grid-cols-3 gap-3 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-5">
                {hidden.map((item) => (
                  <PosterTile
                    key={`${item.type}:${item.tmdbId}`}
                    item={item}
                    dimmed
                    action={
                      <button
                        type="button"
                        onClick={() => unhide(item)}
                        title="Restore"
                        aria-label={`Restore ${item.title}`}
                        className={cornerBtn}
                      >
                        <IconRefresh className="text-sm" />
                      </button>
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Export the current setup as a string, or paste someone else's in.
 *
 * The code carries catalogs and display preferences only. It is stated plainly
 * because people paste these into public threads, and "does this contain my
 * Trakt login?" is the first thing anyone sensible would want to know.
 */
function ShareSetup({ onImported }: { onImported: () => void }) {
  const [code, setCode] = useState('');
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  async function exportSetup() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.get<{ code: string }>('/api/catalogs/share');
      setCode(r.code);
    } catch {
      setMsg({ tone: 'err', text: 'Could not build a setup code just now.' });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function importSetup() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ imported: number }>('/api/catalogs/share', { code: paste.trim() });
      setPaste('');
      setMsg({
        tone: 'ok',
        text: `Added ${r.imported} ${r.imported === 1 ? 'catalog' : 'catalogs'}.`,
      });
      onImported();
    } catch (err) {
      setMsg({ tone: 'err', text: err instanceof ApiError ? err.message : 'That code did not work.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Share your setup</h2>
          <p className="text-xs text-faint">
            A setup code holds your catalogs and display preferences. It never holds your account
            logins, so it is safe to post. Importing adds to your catalogs rather than replacing
            them.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          {code ? (
            <Input
              readOnly
              value={code}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
              aria-label="Your setup code"
            />
          ) : (
            <p className="flex-1 self-center text-xs text-muted">
              Build a code you can send to someone else.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={exportSetup} loading={busy && !paste}>
              {code ? 'Rebuild' : 'Create code'}
            </Button>
            {code && (
              <Button variant="secondary" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste a setup code to import"
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            aria-label="Setup code to import"
          />
          <Button onClick={importSetup} loading={busy && Boolean(paste)} disabled={!paste.trim()}>
            Import
          </Button>
        </div>

        {msg && (
          <p className={`text-xs ${msg.tone === 'ok' ? 'text-success' : 'text-danger'}`}>
            {msg.text}
          </p>
        )}
      </div>
    </Card>
  );
}
