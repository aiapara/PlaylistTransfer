import assert from "node:assert/strict";
import test from "node:test";
import { calculateTransferProgress, type TransferSummary } from "../packages/shared/src/index.js";

function summary(overrides: Partial<TransferSummary>): TransferSummary {
  return {
    id: "tr_test",
    playlistTitle: "Playlist",
    status: "ready",
    totalTracks: 10,
    matchingCompleted: 10,
    transferable: 5,
    matched: 5,
    approved: 0,
    review: 3,
    unmatched: 2,
    unresolved: 5,
    skipped: 0,
    transferred: 0,
    added: 0,
    failed: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("matching progress uses total tracks as the denominator", () => {
  const progress = calculateTransferProgress(
    summary({
      status: "matching",
      totalTracks: 20,
      matchingCompleted: 7,
      transferable: 0,
      matched: 0
    })
  );

  assert.equal(progress.phase, "matching");
  assert.equal(progress.completed, 7);
  assert.equal(progress.total, 20);
  assert.equal(progress.percent, 35);
});

test("transfer progress cannot exceed 100 percent when items fail or skip", () => {
  const progress = calculateTransferProgress(
    summary({
      status: "failed",
      transferable: 4,
      matched: 0,
      transferred: 2,
      added: 2,
      skipped: 1,
      failed: 3
    })
  );

  assert.equal(progress.phase, "transfer");
  assert.equal(progress.completed, 6);
  assert.equal(progress.total, 6);
  assert.equal(progress.percent, 100);
});

test("completed transfers with no actionable items report complete progress", () => {
  const progress = calculateTransferProgress(
    summary({
      status: "completed",
      transferable: 0,
      matched: 0,
      transferred: 0,
      skipped: 0,
      failed: 0
    })
  );

  assert.equal(progress.percent, 100);
});
