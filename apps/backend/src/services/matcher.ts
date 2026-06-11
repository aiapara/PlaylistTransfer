import type { CandidateDiagnostics, CandidateMatch, MatchExplanation, MatchResult, TrackRef } from "@playlist-transfer/shared";
import { env } from "../env.js";
import { searchYoutube } from "./youtube.js";

const REMOVABLE_PARENS = /\((?:[^)]*(?:remaster(?:ed)?|live|mono|stereo|radio edit|explicit|deluxe|anniversary)[^)]*)\)/gi;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

export function normalizeText(value: string): string {
  return value
    .replace(REMOVABLE_PARENS, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function matchTrack(track: TrackRef): Promise<MatchResult> {
  const query = [track.title, track.artists[0], track.album].filter(Boolean).join(" ");
  const candidates = await searchYoutube(query);

  const scored = rankCandidates(track, candidates);

  const selected = scored[0];

  if (!selected) {
    return {
      track,
      candidates: [],
      status: "unmatched",
      selectionSource: "none",
      reason: "No YouTube candidates found.",
      explanation: explainMatch([], undefined, "No YouTube candidates found.")
    };
  }

  if (selected.score >= env.MATCH_CONFIDENCE_THRESHOLD) {
    return {
      track,
      selected,
      candidates: scored,
      status: "matched",
      selectionSource: "automatic",
      explanation: explainMatch(scored, selected, "High-confidence automatic match.")
    };
  }

  if (selected.score >= 0.52) {
    return {
      track,
      selected,
      candidates: scored,
      status: "review",
      selectionSource: "automatic",
      reason: "Best candidate needs manual review.",
      explanation: explainMatch(scored, selected, "Best candidate needs manual review.")
    };
  }

  return {
    track,
    candidates: scored,
    status: "unmatched",
    selectionSource: "none",
    reason: "No candidate reached the minimum confidence score.",
    explanation: explainMatch(scored, selected, "No candidate reached the minimum confidence score.")
  };
}

export function rankCandidates(track: TrackRef, candidates: CandidateMatch[]): CandidateMatch[] {
  return candidates.map((candidate) => scoreCandidate(track, candidate)).sort((a, b) => b.score - a.score);
}

export function scoreCandidate(track: TrackRef, candidate: CandidateMatch): CandidateMatch {
  const trackTitle = normalizeText(track.title);
  const artist = normalizeText(track.artists.join(" "));
  const album = normalizeText(track.album ?? "");
  const candidateArtists = candidate.metadata?.artists?.map((item) => item.name).join(" ") ?? "";
  const candidateAlbum = candidate.metadata?.album ?? "";
  const haystack = normalizeText(
    `${candidate.title} ${candidate.channelTitle} ${candidate.description ?? ""} ${candidateArtists} ${candidateAlbum}`
  );
  const candidateTitle = normalizeText(candidate.title);

  const titleScore = Math.max(bestTokenSimilarity(trackTitle, candidateTitle), bestTokenSimilarity(trackTitle, haystack));
  const artistScore = bestTokenSimilarity(artist, haystack);
  const albumScore = album ? bestTokenSimilarity(album, normalizeText(`${candidateAlbum} ${candidate.description ?? ""}`)) : 0.62;
  const duration = durationScore(track.durationMs, candidate.durationMs);
  const durationSimilarity = duration?.score;
  const durationDifferenceMs = duration?.differenceMs;
  const { amount: penalty, reasons: penalties } = candidatePenalty(track, haystack);
  const { amount: bonus, reasons: bonuses } = candidateBonus(track, candidate, haystack);
  const durationWeight = durationSimilarity === undefined ? 0.08 : 0.16;
  const base =
    titleScore * 0.42 +
    artistScore * 0.27 +
    (durationSimilarity ?? 0.72) * durationWeight +
    albumScore * 0.08 +
    sourceQuality(candidate) * 0.07;
  const score = clamp(base + bonus - penalty, 0, 1);
  const confidence = score >= env.MATCH_CONFIDENCE_THRESHOLD ? "high" : score >= 0.52 ? "medium" : "low";
  const diagnostics: CandidateDiagnostics = {
    titleSimilarity: titleScore,
    artistSimilarity: artistScore,
    durationSimilarity,
    albumSimilarity: album ? albumScore : undefined,
    overallScore: score,
    confidence,
    durationDifferenceMs,
    penalties,
    bonuses,
    reasons: candidateReasons({
      titleScore,
      artistScore,
      albumScore: album ? albumScore : undefined,
      durationDifferenceMs,
      penalties,
      bonuses,
      hasArtistMetadata: Boolean(candidate.metadata?.artists?.length)
    })
  };

  return {
    ...candidate,
    score,
    confidence,
    metadata: enrichScoredMetadata(track, candidate),
    diagnostics
  };
}

function explainMatch(candidates: CandidateMatch[], selected: CandidateMatch | undefined, summary: string): MatchExplanation {
  const reasons = new Set<string>();
  if (selected?.diagnostics?.reasons) {
    selected.diagnostics.reasons.forEach((reason) => reasons.add(reason));
  }

  const second = candidates[1];
  if (selected && second && selected.score - second.score < 0.06) {
    reasons.add("Multiple similar candidates found.");
  }

  if (selected?.diagnostics?.durationDifferenceMs && selected.diagnostics.durationDifferenceMs > 12_000) {
    reasons.add(`Duration differs by ${Math.round(selected.diagnostics.durationDifferenceMs / 1000)} seconds.`);
  }

  if (selected?.diagnostics?.artistSimilarity !== undefined && selected.diagnostics.artistSimilarity < 0.58) {
    reasons.add("Artist match confidence low.");
  }

  return {
    summary,
    reasons: [...reasons],
    candidateCount: candidates.length,
    bestScore: selected?.score
  };
}

function durationScore(sourceMs: number | undefined, candidateMs: number | undefined): { score: number; differenceMs: number } | undefined {
  if (!sourceMs || !candidateMs) return undefined;
  const differenceMs = Math.abs(sourceMs - candidateMs);
  if (differenceMs <= 2500) return { score: 1, differenceMs };
  return {
    score: clamp(1 - differenceMs / 60_000, 0, 1),
    differenceMs
  };
}

function sourceQuality(candidate: CandidateMatch): number {
  if (candidate.metadata?.source === "official_track" || candidate.metadata?.isOfficialTrack) return 1;
  if (candidate.metadata?.source === "official_artist" || candidate.metadata?.isOfficialArtist) return 0.88;
  if (candidate.channelTitle.endsWith(" - Topic")) return 0.82;
  if (candidate.metadata?.source === "youtube_music") return 0.76;
  return 0.5;
}

function enrichScoredMetadata(track: TrackRef, candidate: CandidateMatch): CandidateMatch["metadata"] {
  const metadata = candidate.metadata;
  const channel = normalizeText(candidate.channelTitle);
  const officialArtist = track.artists.some((artist) => {
    const normalized = normalizeText(artist);
    return channel === normalized || channel === `${normalized} vevo` || channel === `${normalized} official`;
  });

  if (!officialArtist) return metadata;

  const base = metadata ?? {
    source: "official_artist" as const,
    sourceLabel: "Official Artist"
  };

  return {
    ...base,
    source: metadata?.source === "official_track" ? "official_track" : "official_artist",
    sourceLabel: metadata?.source === "official_track" ? "Official Track" : "Official Artist",
    isOfficialArtist: true,
    artists: metadata?.artists?.length
      ? metadata.artists.map((artist) => ({ ...artist, isOfficial: artist.isOfficial || normalizeText(artist.name) === channel }))
      : track.artists.map((artist) => ({ name: artist, isOfficial: normalizeText(artist) === channel })),
    badges: [...new Set([...(metadata?.badges ?? []), "Official Artist"])]
  };
}

function candidateBonus(track: TrackRef, candidate: CandidateMatch, haystack: string): { amount: number; reasons: string[] } {
  const reasons: string[] = [];
  let amount = 0;
  const normalizedArtists = track.artists.map((artist) => normalizeText(artist));
  const channel = normalizeText(candidate.channelTitle);

  if (candidate.metadata?.isOfficialTrack || candidate.metadata?.source === "official_track") {
    amount += 0.08;
    reasons.push("Official music track.");
  }

  if (candidate.metadata?.isOfficialArtist || normalizedArtists.some((artist) => channel === artist || channel === `${artist} vevo`)) {
    amount += 0.06;
    reasons.push("Official artist upload.");
  }

  if (candidate.channelTitle.endsWith(" - Topic")) {
    amount += 0.04;
    reasons.push("Topic channel catalog entry.");
  }

  if (track.album && candidate.metadata?.album && normalizeText(track.album) === normalizeText(candidate.metadata.album)) {
    amount += 0.03;
    reasons.push("Album metadata matches.");
  } else if (track.album && haystack.includes(normalizeText(track.album))) {
    amount += 0.02;
    reasons.push("Album title appears in candidate metadata.");
  }

  return { amount: Math.min(amount, 0.16), reasons };
}

function candidatePenalty(track: TrackRef, haystack: string): { amount: number; reasons: string[] } {
  const sourceTitle = normalizeText(track.title);
  const penalties: { pattern: RegExp; amount: number; reason: string; sourcePattern?: RegExp }[] = [
    { pattern: /\blyric(s)?\b|\blyric video\b/, amount: 0.06, reason: "Lyric video penalty.", sourcePattern: /\blyric(s)?\b/ },
    { pattern: /\bfan\s*(made|upload|video)\b|\bcover\b|\bkaraoke\b/, amount: 0.16, reason: "Fan, cover, or karaoke upload penalty." },
    { pattern: /\breaction\b|\breview\b/, amount: 0.2, reason: "Reaction or commentary video penalty." },
    { pattern: /\blive\b|\bconcert\b|\bsession\b/, amount: 0.1, reason: "Live performance penalty.", sourcePattern: /\blive\b/ },
    { pattern: /\bremix\b|\bremaster(?:ed)?\b|\bedit\b/, amount: 0.08, reason: "Alternate version penalty.", sourcePattern: /\bremix\b|\bremaster(?:ed)?\b|\bedit\b/ },
    { pattern: /\bnightcore\b|\bsped\s*up\b|\bslowed\b|\breverb\b/, amount: 0.18, reason: "Speed-altered version penalty." }
  ];

  let amount = 0;
  const reasons: string[] = [];
  for (const penalty of penalties) {
    if (!penalty.pattern.test(haystack)) continue;
    if (penalty.sourcePattern?.test(sourceTitle)) continue;
    amount += penalty.amount;
    reasons.push(penalty.reason);
  }

  return { amount: Math.min(amount, 0.3), reasons };
}

function candidateReasons(input: {
  titleScore: number;
  artistScore: number;
  albumScore?: number;
  durationDifferenceMs?: number;
  penalties: string[];
  bonuses: string[];
  hasArtistMetadata: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.titleScore < 0.7) reasons.push("Title match confidence low.");
  if (input.artistScore < 0.58) reasons.push("Artist match confidence low.");
  if (input.albumScore !== undefined && input.albumScore < 0.5) reasons.push("Album mismatch.");
  if (input.durationDifferenceMs !== undefined && input.durationDifferenceMs > 12_000) {
    reasons.push(`Duration differs by ${Math.round(input.durationDifferenceMs / 1000)} seconds.`);
  }
  if (!input.hasArtistMetadata) reasons.push("Missing artist metadata.");
  reasons.push(...input.penalties, ...input.bonuses);
  return [...new Set(reasons)];
}

function bestTokenSimilarity(needle: string, haystack: string): number {
  if (!needle) return 0;
  if (haystack.includes(needle)) return 1;

  const needleTokens = needle.split(" ");
  const hayTokens = new Set(haystack.split(" "));
  const overlap = needleTokens.filter((token) => hayTokens.has(token)).length / needleTokens.length;
  const edit = similarity(needle, haystack);

  return Math.max(overlap, edit);
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[a.length][b.length];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
