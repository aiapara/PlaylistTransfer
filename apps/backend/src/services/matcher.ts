import type { CandidateMatch, MatchResult, TrackRef } from "@playlist-transfer/shared";
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

  const scored = candidates
    .map((candidate) => scoreCandidate(track, candidate))
    .sort((a, b) => b.score - a.score);

  const selected = scored[0];

  if (!selected) {
    return { track, candidates: [], status: "unmatched", reason: "No YouTube candidates found." };
  }

  if (selected.score >= env.MATCH_CONFIDENCE_THRESHOLD) {
    return { track, selected, candidates: scored, status: "matched" };
  }

  if (selected.score >= 0.52) {
    return {
      track,
      selected,
      candidates: scored,
      status: "review",
      reason: "Best candidate needs manual review."
    };
  }

  return {
    track,
    candidates: scored,
    status: "unmatched",
    reason: "No candidate reached the minimum confidence score."
  };
}

export function scoreCandidate(track: TrackRef, candidate: CandidateMatch): CandidateMatch {
  const trackTitle = normalizeText(track.title);
  const artist = normalizeText(track.artists.join(" "));
  const album = normalizeText(track.album ?? "");
  const haystack = normalizeText(`${candidate.title} ${candidate.channelTitle} ${candidate.description ?? ""}`);

  const titleScore = bestTokenSimilarity(trackTitle, haystack);
  const artistScore = bestTokenSimilarity(artist, haystack);
  const albumScore = album ? bestTokenSimilarity(album, haystack) : 0.5;
  const penalty = /\bcover\b|\bkaraoke\b|\breaction\b|\blyrics only\b/.test(haystack) ? 0.14 : 0;
  const score = clamp(titleScore * 0.55 + artistScore * 0.32 + albumScore * 0.13 - penalty, 0, 1);

  return {
    ...candidate,
    score,
    confidence: score >= env.MATCH_CONFIDENCE_THRESHOLD ? "high" : score >= 0.52 ? "medium" : "low"
  };
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
