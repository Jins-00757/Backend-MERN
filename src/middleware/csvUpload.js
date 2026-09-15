import multer from 'multer';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { mkdirSync } from 'fs';
import { rm } from 'fs/promises';

// Every bulk-import CSV lands in its own private, randomly-named temp
// directory (not a shared uploads/ folder) so two concurrent uploads can
// never collide on a filename, and there's nothing predictable for an
// attacker to guess/overwrite. bulkOperationsController is responsible for
// deleting the whole directory in a `finally` once the file has been read
// (see removeUploadedFile below) - nothing here is meant to persist.
const uploadRoot = () => {
  const dir = path.join(os.tmpdir(), 'sales-pipeline-bulk-uploads', crypto.randomUUID());
  return dir;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = uploadRoot();
    try {
      mkdirSync(dir, { recursive: true });
      req.uploadDir = dir;
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // Never trust the client-supplied filename for the on-disk name (path
    // traversal, collisions, unexpected characters) - keep the original
    // only for display/validation, store under a fixed safe name.
    cb(null, 'upload.csv');
  },
});

const MAX_CSV_BYTES = 50 * 1024 * 1024; // 50MB, per the file-security requirement

/**
 * Accept only files that both claim a CSV mimetype AND have a .csv
 * extension - relying on either alone is easy to spoof (browsers/curl let
 * the caller set Content-Type freely, and a renamed .exe can still end in
 * ".csv"), but requiring both makes a deliberately mislabeled upload
 * noticeably harder to sneak through without actually being CSV-shaped.
 * This is a first filter, not a content validator - bulkOperationsController
 * still parses and hash-verifies the actual bytes after upload.
 */
const CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel', // what Excel-exported CSVs commonly report
  'text/plain', // many OSes/browsers have no CSV entry and fall back to this
]);

const fileFilter = (req, file, cb) => {
  const hasCsvExtension = /\.csv$/i.test(file.originalname || '');
  const hasCsvMimeType = CSV_MIME_TYPES.has(file.mimetype);

  if (!hasCsvExtension || !hasCsvMimeType) {
    const err = new Error('Only .csv files are accepted');
    err.status = 400;
    return cb(err);
  }

  cb(null, true);
};

export const csvUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_CSV_BYTES,
    files: 1,
  },
});

/**
 * Delete the temp upload directory (and its single file) for this request.
 * Always call this in a `finally` around whatever reads req.file - a
 * request that throws partway through parsing must not leave the upload
 * sitting on disk indefinitely.
 */
export const cleanupUpload = async (req) => {
  if (!req.uploadDir) return;

  try {
    await rm(req.uploadDir, { recursive: true, force: true });
  } catch (err) {
    console.error('Failed to clean up uploaded CSV temp file:', err.message);
  }
};

/**
 * Express error handler for multer-specific failures (file too large, wrong
 * type, etc.) - multer's errors don't flow through the app's normal
 * AppError shape, so translate them into the same
 * `{ success: false, message }` response every other bulk-operations
 * endpoint already returns.
 *
 * Also responsible for cleanup here specifically: a multer-level rejection
 * (e.g. the 50MB limit) happens *before* the route handler ever runs, so
 * that handler's own `finally { cleanupUpload(req) }` never fires - multer
 * does delete the partial file it was writing, but the per-request temp
 * directory destination() created still exists, so it must be removed here
 * instead, or every rejected upload leaks one empty directory.
 */
export const handleCsvUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `CSV file exceeds the 50MB limit`
        : `Upload error: ${err.message}`;
    cleanupUpload(req).finally(() => res.status(400).json({ success: false, message }));
    return;
  }

  if (err && err.status === 400) {
    cleanupUpload(req).finally(() => res.status(400).json({ success: false, message: err.message }));
    return;
  }

  next(err);
};
