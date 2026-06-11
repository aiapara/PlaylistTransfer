import { calculateTransferProgress, type AuthStatus, type MatchResult, type SourcePlaylist, type TransferDetail, type TransferSummary } from "@playlist-transfer/shared";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Download,
  FolderOpen,
  History,
  ListMusic,
  Moon,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sun,
  ThumbsUp,
  Youtube
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { client, type DesktopSettings, type SettingsUpdate } from "./api.js";

type Step = "setup" | "spotify" | "youtube" | "select" | "preview" | "transfer";
type ReviewFilter = "all" | "matched" | "approved" | "review" | "unmatched" | "skipped";

export function App() {
  const [auth, setAuth] = useState<AuthStatus>({ spotify: false, youtube: false });
  const [settings, setSettings] = useState<DesktopSettings | undefined>();
  const [settingsForm, setSettingsForm] = useState<SettingsUpdate>(emptySettingsForm());
  const [settingsMessage, setSettingsMessage] = useState("");
  const [playlists, setPlaylists] = useState<SourcePlaylist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("liked-songs");
  const [transfer, setTransfer] = useState<TransferDetail | undefined>();
  const [history, setHistory] = useState<TransferSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(true);
  const [filter, setFilter] = useState("");

  const setupReady = settings?.setup.ready ?? false;
  const step: Step = !setupReady
    ? "setup"
    : !auth.spotify
      ? "spotify"
      : !auth.youtube
        ? "youtube"
        : !transfer
          ? "select"
          : transfer.status === "ready"
            ? "preview"
            : "transfer";

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    void refresh();
    const refreshOnFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, []);

  useEffect(() => {
    if (!settings) return;
    setSettingsForm({
      spotify: {
        clientId: settings.spotify.clientId,
        clientSecret: "",
        redirectUri: settings.spotify.redirectUri || settings.requiredRedirectUris.spotify
      },
      youtube: {
        clientId: settings.youtube.clientId,
        clientSecret: "",
        redirectUri: settings.youtube.redirectUri || settings.requiredRedirectUris.youtube
      }
    });
  }, [settings]);

  useEffect(() => {
    if (auth.spotify) void loadPlaylists();
  }, [auth.spotify]);

  useEffect(() => {
    if (!transfer || !["matching", "running"].includes(transfer.status)) return;
    const timer = window.setInterval(() => {
      void client.transfer(transfer.id).then(setTransfer).catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [transfer]);

  const selectedPlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const visiblePlaylists = playlists.filter((playlist) => playlist.title.toLowerCase().includes(filter.toLowerCase()));
  const progress = transfer ? calculateTransferProgress(transfer) : undefined;

  async function refresh() {
    setError("");
    try {
      const nextSettings = await client.settings();
      setSettings(nextSettings);
      if (!nextSettings.setup.ready) {
        setAuth({ spotify: false, youtube: false });
        setHistory([]);
        return;
      }

      const [status, transfers] = await Promise.all([client.status(), client.transfers()]);
      setAuth(status);
      setHistory(transfers);
    } catch (err) {
      setError(messageFor(err));
    }
  }

  async function saveSettings() {
    setBusy(true);
    setError("");
    setSettingsMessage("");
    try {
      const nextSettings = await client.saveSettings(settingsForm);
      setSettings(nextSettings);
      setSettingsMessage("Settings saved.");
      await refresh();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function openConfigFolder() {
    setError("");
    try {
      await client.openConfigFolder();
    } catch (err) {
      setError(messageFor(err));
    }
  }

  async function loadPlaylists() {
    setError("");
    try {
      setPlaylists(await client.playlists());
    } catch (err) {
      setError(messageFor(err));
    }
  }

  async function preview() {
    if (!selectedPlaylist) return;
    setBusy(true);
    setError("");
    try {
      setTransfer(await client.preview(selectedPlaylist.id));
      await refresh();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function startTransfer() {
    if (!transfer) return;
    setBusy(true);
    setError("");
    try {
      setTransfer(await client.start(transfer.id));
      await refresh();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function approveMatch(item: MatchResult, videoId: string) {
    if (!transfer || !item.id) return;
    setBusy(true);
    setError("");
    try {
      setTransfer(await client.approveMatch(transfer.id, item.id, videoId));
      await refresh();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function skipMatch(item: MatchResult) {
    if (!transfer || !item.id) return;
    setBusy(true);
    setError("");
    try {
      setTransfer(await client.skipMatch(transfer.id, item.id));
      await refresh();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function searchMatch(item: MatchResult, query: string) {
    if (!transfer || !item.id) return;
    setBusy(true);
    setError("");
    try {
      setTransfer(await client.searchMatch(transfer.id, item.id, query));
      await refresh();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function createSpotifyLikedPlaylist() {
    setBusy(true);
    setError("");
    try {
      await client.materializeLiked();
      await loadPlaylists();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Playlist Transfer</h1>
          <p>Spotify playlists into YouTube playlists for YouTube Music listening.</p>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => setDark((value) => !value)} title="Toggle dark mode">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button" onClick={() => setSettings((value) => value && { ...value, setup: { ...value.setup, ready: false } })} title="Settings">
            <Settings size={18} />
          </button>
          <button className="icon-button" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      {error && (
        <div className="notice error">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      <Workflow step={step} auth={auth} />

      <section className="workspace">
        <aside className="sidebar">
          <AuthPanel auth={auth} />
          {settings?.configDir && <ConfigPanel settings={settings} onOpen={() => void openConfigFolder()} />}
          <HistoryPanel history={history} onOpen={(id) => void client.transfer(id).then(setTransfer).catch((err) => setError(messageFor(err)))} />
        </aside>

        <section className="main-panel">
          {step === "setup" && settings && (
            <SettingsPanel
              settings={settings}
              form={settingsForm}
              busy={busy}
              message={settingsMessage}
              onChange={setSettingsForm}
              onSave={() => void saveSettings()}
              onOpenConfigFolder={() => void openConfigFolder()}
            />
          )}

          {step === "spotify" && <LoginGate provider="Spotify" href="/api/auth/spotify/login" icon={<ListMusic />} />}
          {step === "youtube" && <LoginGate provider="YouTube Music" href="/api/auth/youtube/login" icon={<Youtube />} />}

          {step === "select" && (
            <PlaylistPicker
              playlists={visiblePlaylists}
              selectedId={selectedPlaylistId}
              filter={filter}
              busy={busy}
              onFilter={setFilter}
              onSelect={setSelectedPlaylistId}
              onPreview={() => void preview()}
              onMaterializeLiked={() => void createSpotifyLikedPlaylist()}
            />
          )}

          {(step === "preview" || step === "transfer") && transfer && (
            <TransferView
              transfer={transfer}
              progress={progress}
              busy={busy}
              onStart={() => void startTransfer()}
              onBack={() => setTransfer(undefined)}
              onApprove={(item, videoId) => void approveMatch(item, videoId)}
              onSkip={(item) => void skipMatch(item)}
              onSearch={(item, query) => void searchMatch(item, query)}
            />
          )}
        </section>
      </section>
    </main>
  );
}

function Workflow({ step, auth }: { step: Step; auth: AuthStatus }) {
  const steps = [
    { id: "setup", label: "Setup", done: step !== "setup" },
    { id: "spotify", label: "Spotify", done: auth.spotify },
    { id: "youtube", label: "YouTube Music", done: auth.youtube },
    { id: "select", label: "Select", done: ["preview", "transfer"].includes(step) },
    { id: "preview", label: "Preview", done: step === "transfer" },
    { id: "transfer", label: "Transfer", done: false }
  ];

  return (
    <nav className="workflow">
      {steps.map((item) => (
        <div className={`step ${step === item.id ? "active" : ""} ${item.done ? "done" : ""}`} key={item.id}>
          <span>{item.done ? <Check size={15} /> : item.label.slice(0, 1)}</span>
          {item.label}
        </div>
      ))}
    </nav>
  );
}

function ConfigPanel({ settings, onOpen }: { settings: DesktopSettings; onOpen: () => void }) {
  return (
    <div className="panel compact">
      <h2>
        <Settings size={17} />
        Setup
      </h2>
      <div className="config-path">
        <span>{settings.setup.ready ? "Ready" : "Needs setup"}</span>
        {settings.configPath && <small>{settings.configPath}</small>}
      </div>
      <button className="secondary-button full-width" onClick={onOpen}>
        <FolderOpen size={17} />
        Open Config Folder
      </button>
    </div>
  );
}

function AuthPanel({ auth }: { auth: AuthStatus }) {
  return (
    <div className="panel compact">
      <h2>Connections</h2>
      <div className="status-line">
        <ListMusic size={18} />
        <span>Spotify</span>
        <strong>{auth.spotify ? "Connected" : "Needed"}</strong>
      </div>
      <div className="status-line">
        <Youtube size={18} />
        <span>YouTube</span>
        <strong>{auth.youtube ? "Connected" : "Needed"}</strong>
      </div>
    </div>
  );
}

function HistoryPanel({ history, onOpen }: { history: TransferSummary[]; onOpen: (id: string) => void }) {
  return (
    <div className="panel compact">
      <h2>
        <History size={17} />
        Transfers
      </h2>
      {history.length === 0 ? (
        <p className="muted">No transfer history yet.</p>
      ) : (
        <div className="history-list">
          {history.slice(0, 6).map((item) => (
            <button key={item.id} onClick={() => onOpen(item.id)}>
              <span>{item.playlistTitle}</span>
              <small>{item.status}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LoginGate({ provider, href, icon }: { provider: string; href: string; icon: ReactNode }) {
  return (
    <div className="login-gate">
      <div className="login-icon">{icon}</div>
      <h2>Connect {provider}</h2>
      <p>OAuth opens in this window and returns here when the connection is ready.</p>
      <a className="primary-button" href={href}>
        Connect <ChevronRight size={18} />
      </a>
    </div>
  );
}

function SettingsPanel({
  settings,
  form,
  busy,
  message,
  onChange,
  onSave,
  onOpenConfigFolder
}: {
  settings: DesktopSettings;
  form: SettingsUpdate;
  busy: boolean;
  message: string;
  onChange: (value: SettingsUpdate) => void;
  onSave: () => void;
  onOpenConfigFolder: () => void;
}) {
  return (
    <>
      <div className="section-head">
        <div>
          <h2>Desktop Setup</h2>
          <p>Save OAuth credentials locally before connecting Spotify and YouTube.</p>
        </div>
        <button className="secondary-button" onClick={onOpenConfigFolder}>
          <FolderOpen size={17} />
          Open Config Folder
        </button>
      </div>

      {settings.setup.errors.length > 0 && (
        <div className="notice error stacked">
          <AlertCircle size={18} />
          <div>
            <strong>Setup needs attention</strong>
            <ul>
              {settings.setup.errors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {message && <div className="notice success">{message}</div>}

      <div className="settings-grid">
        <CredentialSection
          title="Spotify"
          clientId={form.spotify.clientId}
          clientSecret={form.spotify.clientSecret}
          clientSecretSet={settings.spotify.clientSecretSet}
          redirectUri={form.spotify.redirectUri}
          requiredRedirectUri={settings.requiredRedirectUris.spotify}
          testHref="/api/auth/spotify/login"
          onClientId={(clientId) => onChange({ ...form, spotify: { ...form.spotify, clientId } })}
          onClientSecret={(clientSecret) => onChange({ ...form, spotify: { ...form.spotify, clientSecret } })}
          onRedirectUri={(redirectUri) => onChange({ ...form, spotify: { ...form.spotify, redirectUri } })}
        />
        <CredentialSection
          title="YouTube"
          clientId={form.youtube.clientId}
          clientSecret={form.youtube.clientSecret}
          clientSecretSet={settings.youtube.clientSecretSet}
          redirectUri={form.youtube.redirectUri}
          requiredRedirectUri={settings.requiredRedirectUris.youtube}
          testHref="/api/auth/youtube/login"
          onClientId={(clientId) => onChange({ ...form, youtube: { ...form.youtube, clientId } })}
          onClientSecret={(clientSecret) => onChange({ ...form, youtube: { ...form.youtube, clientSecret } })}
          onRedirectUri={(redirectUri) => onChange({ ...form, youtube: { ...form.youtube, redirectUri } })}
        />
      </div>

      <div className="footer-actions">
        <button className="primary-button" onClick={onSave} disabled={busy}>
          <Save size={17} />
          {busy ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </>
  );
}

function CredentialSection({
  title,
  clientId,
  clientSecret,
  clientSecretSet,
  redirectUri,
  requiredRedirectUri,
  testHref,
  onClientId,
  onClientSecret,
  onRedirectUri
}: {
  title: string;
  clientId: string;
  clientSecret: string;
  clientSecretSet: boolean;
  redirectUri: string;
  requiredRedirectUri: string;
  testHref: string;
  onClientId: (value: string) => void;
  onClientSecret: (value: string) => void;
  onRedirectUri: (value: string) => void;
}) {
  return (
    <section className="settings-section">
      <div className="section-title-row">
        <h3>{title}</h3>
        <a className="secondary-button" href={testHref}>
          Test {title} Login
          <ChevronRight size={17} />
        </a>
      </div>
      <label className="field">
        <span>Client ID</span>
        <input value={clientId} onChange={(event) => onClientId(event.target.value)} />
      </label>
      <label className="field">
        <span>Client Secret</span>
        <input
          type="password"
          value={clientSecret}
          onChange={(event) => onClientSecret(event.target.value)}
          placeholder={clientSecretSet ? "Saved. Leave blank to keep existing secret." : ""}
        />
      </label>
      <label className="field">
        <span>Redirect URI</span>
        <input value={redirectUri} onChange={(event) => onRedirectUri(event.target.value)} />
      </label>
      <div className={redirectUri === requiredRedirectUri ? "redirect-check ok" : "redirect-check"}>
        <Check size={15} />
        <span>{requiredRedirectUri}</span>
      </div>
    </section>
  );
}

function PlaylistPicker({
  playlists,
  selectedId,
  filter,
  busy,
  onFilter,
  onSelect,
  onPreview,
  onMaterializeLiked
}: {
  playlists: SourcePlaylist[];
  selectedId: string;
  filter: string;
  busy: boolean;
  onFilter: (value: string) => void;
  onSelect: (id: string) => void;
  onPreview: () => void;
  onMaterializeLiked: () => void;
}) {
  return (
    <>
      <div className="section-head">
        <div>
          <h2>Select Playlist</h2>
          <p>Liked Songs appears as a virtual playlist and can transfer directly.</p>
        </div>
        <button className="secondary-button" onClick={onMaterializeLiked} disabled={busy} title="Create private Spotify playlist from Liked Songs">
          <ThumbsUp size={17} />
          Create Liked Playlist
        </button>
      </div>

      <label className="search-box">
        <Search size={18} />
        <input value={filter} onChange={(event) => onFilter(event.target.value)} placeholder="Search playlists" />
      </label>

      <div className="playlist-grid">
        {playlists.map((playlist) => (
          <button
            className={`playlist-card ${selectedId === playlist.id ? "selected" : ""}`}
            key={playlist.id}
            onClick={() => onSelect(playlist.id)}
          >
            <div className="cover">{playlist.imageUrl ? <img src={playlist.imageUrl} alt="" /> : <ListMusic size={28} />}</div>
            <div>
              <h3>{playlist.title}</h3>
              <p>{playlist.owner ?? (playlist.isLikedSongs ? "Virtual playlist" : "Spotify")}</p>
              <small>{playlist.totalTracks.toLocaleString()} tracks</small>
            </div>
          </button>
        ))}
      </div>

      <div className="footer-actions">
        <button className="primary-button" onClick={onPreview} disabled={busy || !selectedId}>
          {busy ? "Matching..." : "Preview Matches"}
          <ChevronRight size={18} />
        </button>
      </div>
    </>
  );
}

function TransferView({
  transfer,
  progress,
  busy,
  onStart,
  onBack,
  onApprove,
  onSkip,
  onSearch
}: {
  transfer: TransferDetail;
  progress: ReturnType<typeof calculateTransferProgress> | undefined;
  busy: boolean;
  onStart: () => void;
  onBack: () => void;
  onApprove: (item: MatchResult, videoId: string) => void;
  onSkip: (item: MatchResult) => void;
  onSearch: (item: MatchResult, query: string) => void;
}) {
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const groups = useMemo(() => groupMatches(transfer.matches), [transfer.matches]);
  const reviewTotal = transfer.approved + transfer.skipped + transfer.unresolved;
  const reviewed = transfer.approved + transfer.skipped;
  const canStart = ["ready", "failed", "paused"].includes(transfer.status) && transfer.unresolved === 0;
  const progressView = progress ?? calculateTransferProgress(transfer);
  const visibleItems = useMemo(() => filterMatches(transfer.matches, filter), [filter, transfer.matches]);
  const activeItem = visibleItems[Math.min(activeIndex, Math.max(visibleItems.length - 1, 0))];

  useEffect(() => {
    setActiveIndex(0);
  }, [filter, transfer.id]);

  useEffect(() => {
    if (activeIndex >= visibleItems.length) {
      setActiveIndex(Math.max(visibleItems.length - 1, 0));
    }
  }, [activeIndex, visibleItems.length]);

  return (
    <>
      <div className="section-head">
        <div>
          <h2>{transfer.playlistTitle}</h2>
          <p>{transfer.status} · {transfer.totalTracks.toLocaleString()} source tracks</p>
        </div>
        <div className="action-row">
          <button className="secondary-button" onClick={onBack}>Back</button>
          <a className="secondary-button" href={`/api/transfers/${transfer.id}/unmatched.csv`}>
            <Download size={17} />
            CSV
          </a>
          <button className="primary-button" onClick={onStart} disabled={busy || !canStart}>
            <Play size={17} />
            {transfer.status === "failed" ? "Resume" : "Transfer"}
          </button>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Matched" value={transfer.matched} />
        <Metric label="Approved" value={transfer.approved} />
        <Metric label="Review" value={transfer.review} />
        <Metric label="Unmatched" value={transfer.unmatched} />
        <Metric label="Skipped" value={transfer.skipped} />
        <Metric label="Unresolved" value={transfer.unresolved} />
      </div>

      {transfer.unresolved > 0 && transfer.status !== "matching" && (
        <div className="notice warning">
          <AlertCircle size={18} />
          <span>{transfer.unresolved.toLocaleString()} tracks still need review. Approve or skip them before transferring.</span>
        </div>
      )}

      <div className="progress-wrap">
        <div className="progress-label">
          <span>{progressView.phase === "matching" ? "Matching progress" : "Transfer progress"}</span>
          <strong>{progressView.percent}%</strong>
        </div>
        <div className="progress-bar">
          <span style={{ width: `${progressView.percent}%` }} />
        </div>
        <p className="progress-detail">
          {progressView.completed.toLocaleString()} of {progressView.total.toLocaleString()} {progressView.phase === "matching" ? "tracks matched" : "items handled"}
        </p>
      </div>

      <section className="review-workspace">
        <div className="section-head">
          <div>
            <h2>Match Review</h2>
            <p>{reviewed.toLocaleString()} of {reviewTotal.toLocaleString()} tracks reviewed</p>
          </div>
          <div className="review-nav">
            <button className="secondary-button" onClick={() => setActiveIndex((value) => Math.max(0, value - 1))} disabled={activeIndex <= 0}>
              Back
            </button>
            <span>{visibleItems.length === 0 ? "0 of 0" : `${Math.min(activeIndex + 1, visibleItems.length)} of ${visibleItems.length}`}</span>
            <button
              className="secondary-button"
              onClick={() => setActiveIndex((value) => Math.min(visibleItems.length - 1, value + 1))}
              disabled={activeIndex >= visibleItems.length - 1}
            >
              Next
            </button>
          </div>
        </div>

        <div className="filter-tabs">
          {filterOptions(groups).map((option) => (
            <button className={filter === option.id ? "active" : ""} key={option.id} onClick={() => setFilter(option.id)}>
              {option.label}
              <span>{option.count}</span>
            </button>
          ))}
        </div>

        {activeItem ? (
          <ReviewItem
            item={activeItem}
            busy={busy}
            onApprove={(videoId) => onApprove(activeItem, videoId)}
            onSkip={() => onSkip(activeItem)}
            onSearch={(query) => onSearch(activeItem, query)}
          />
        ) : (
          <div className="empty-review">
            <Check size={28} />
            <strong>No tracks in this filter</strong>
          </div>
        )}
      </section>

      <LogList transfer={transfer} />
    </>
  );
}

function ReviewItem({
  item,
  busy,
  onApprove,
  onSkip,
  onSearch
}: {
  item: MatchResult;
  busy: boolean;
  onApprove: (videoId: string) => void;
  onSkip: () => void;
  onSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState(defaultSearchQuery(item));

  useEffect(() => {
    setQuery(defaultSearchQuery(item));
  }, [item.id]);

  return (
    <div className={`review-card status-${item.status}`}>
      <div className="review-source">
        <div>
          <span className={`status-pill status-${item.status}`}>{statusLabel(item)}</span>
          <h3>{item.track.title}</h3>
          <p>{item.track.artists.join(", ")}</p>
          <small>
            {item.track.album ?? "No album"} · {formatDuration(item.track.durationMs)}
          </small>
        </div>
        <div className="review-reason">
          <strong>{item.reason ?? reasonForStatus(item)}</strong>
          <span>{item.selectionSource === "manual" ? "Manually reviewed" : item.selectionSource === "automatic" ? "Automatic matcher" : "No approved match"}</span>
        </div>
      </div>

      <div className="review-search">
        <label className="search-box">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search YouTube Music" />
        </label>
        <button className="secondary-button" onClick={() => onSearch(query)} disabled={busy || !query.trim()}>
          Search Again
        </button>
        <button className="secondary-button" onClick={onSkip} disabled={busy || item.status === "skipped" || item.status === "transferred"}>
          Skip Track
        </button>
      </div>

      <div className="candidate-list">
        {item.candidates.length === 0 ? (
          <div className="candidate-empty">No candidates available. Try a different search.</div>
        ) : (
          item.candidates.map((candidate) => (
            <div className={`candidate-row ${item.selected?.videoId === candidate.videoId ? "selected" : ""}`} key={candidate.videoId}>
              <div>
                <strong>{candidate.title}</strong>
                <span>{candidate.channelTitle}</span>
                <small>{formatDuration(candidate.durationMs)} · {(candidate.score * 100).toFixed(0)}% · {candidate.confidence}</small>
              </div>
              <button className="primary-button" onClick={() => onApprove(candidate.videoId)} disabled={busy || item.status === "transferred"}>
                Approve
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function groupMatches(items: MatchResult[]) {
  return {
    all: items.filter((item) => ["matched", "approved", "review", "unmatched", "skipped"].includes(item.status)),
    matched: items.filter((item) => item.status === "matched"),
    approved: items.filter((item) => item.status === "approved"),
    review: items.filter((item) => item.status === "review"),
    unmatched: items.filter((item) => item.status === "unmatched"),
    skipped: items.filter((item) => item.status === "skipped")
  };
}

function filterMatches(items: MatchResult[], filter: ReviewFilter): MatchResult[] {
  if (filter === "all") return groupMatches(items).all;
  return items.filter((item) => item.status === filter);
}

function filterOptions(groups: ReturnType<typeof groupMatches>): { id: ReviewFilter; label: string; count: number }[] {
  return [
    { id: "all", label: "All", count: groups.all.length },
    { id: "matched", label: "Matched", count: groups.matched.length },
    { id: "approved", label: "Approved", count: groups.approved.length },
    { id: "review", label: "Review", count: groups.review.length },
    { id: "unmatched", label: "Unmatched", count: groups.unmatched.length },
    { id: "skipped", label: "Skipped", count: groups.skipped.length }
  ];
}

function statusLabel(item: MatchResult): string {
  if (item.status === "matched") return "Automatic match";
  if (item.status === "approved") return "Approved";
  if (item.status === "review") return "Needs review";
  if (item.status === "unmatched") return "Unmatched";
  if (item.status === "skipped") return "Skipped";
  return item.status;
}

function reasonForStatus(item: MatchResult): string {
  if (item.status === "matched") return "High-confidence automatic match.";
  if (item.status === "approved") return "Approved manually.";
  if (item.status === "skipped") return "Skipped intentionally.";
  return "Select a candidate or skip this track.";
}

function defaultSearchQuery(item: MatchResult): string {
  return [item.track.title, item.track.artists[0], item.track.album].filter(Boolean).join(" ");
}

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs) return "Duration unavailable";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function LogList({ transfer }: { transfer: TransferDetail }) {
  return (
    <section className="match-section">
      <h3>Operations Log</h3>
      <div className="log-list">
        {transfer.logs.slice(-40).map((log) => (
          <div className={`log-line ${log.level}`} key={log.id}>
            <span>{new Date(log.createdAt).toLocaleTimeString()}</span>
            <p>{log.message}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function emptySettingsForm(): SettingsUpdate {
  return {
    spotify: {
      clientId: "",
      clientSecret: "",
      redirectUri: ""
    },
    youtube: {
      clientId: "",
      clientSecret: "",
      redirectUri: ""
    }
  };
}
