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
  onBack
}: {
  transfer: TransferDetail;
  progress: ReturnType<typeof calculateTransferProgress> | undefined;
  busy: boolean;
  onStart: () => void;
  onBack: () => void;
}) {
  const groups = useMemo(
    () => ({
      matched: transfer.matches.filter((item) => item.status === "matched" && item.selected?.confidence === "high"),
      review: transfer.matches.filter((item) => item.status === "review"),
      unmatched: transfer.matches.filter((item) => item.status === "unmatched"),
      failed: transfer.matches.filter((item) => item.status === "failed"),
      skipped: transfer.matches.filter((item) => item.status === "skipped"),
      transferred: transfer.matches.filter((item) => item.status === "transferred")
    }),
    [transfer.matches]
  );
  const canStart = ["ready", "failed", "paused"].includes(transfer.status);
  const progressView = progress ?? calculateTransferProgress(transfer);

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
        <Metric label="Review" value={transfer.review} />
        <Metric label="Unmatched" value={transfer.unmatched} />
        <Metric label="Transferred" value={transfer.transferred} />
        <Metric label="Failed" value={transfer.failed} />
      </div>

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

      <MatchTable title="Matched" items={groups.matched} />
      <MatchTable title="Manual Review" items={groups.review} />
      <MatchTable title="Unmatched" items={groups.unmatched} />
      <MatchTable title="Failed" items={groups.failed} />
      <MatchTable title="Skipped" items={groups.skipped} />
      <MatchTable title="Transferred" items={groups.transferred} />
      <LogList transfer={transfer} />
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function MatchTable({ title, items }: { title: string; items: MatchResult[] }) {
  if (items.length === 0) return null;

  return (
    <section className="match-section">
      <h3>{title}</h3>
      <div className="match-list">
        {items.slice(0, 80).map((item) => (
          <div className="match-row" key={`${item.track.sourceId}-${item.status}`}>
            <div>
              <strong>{item.track.title}</strong>
              <span>{item.track.artists.join(", ")}{item.track.album ? ` · ${item.track.album}` : ""}</span>
            </div>
            <div>
              <strong>{item.selected?.title ?? "No match"}</strong>
              <span>{item.selected ? `${item.selected.channelTitle} · ${(item.selected.score * 100).toFixed(0)}%` : item.reason}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
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
