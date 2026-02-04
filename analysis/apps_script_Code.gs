function doGet(e) {
  const action = String(e && e.parameter && e.parameter.action || "").toLowerCase();
  if (action === "listsheets") {
    return withCors(jsonOut({ ok: true, sheets: listParticipantSheets() }));
  }
  if (action === "csv") {
    const sheetName = String(e && e.parameter && e.parameter.sheet || "").trim();
    if (!sheetName) {
      return withCors(jsonOut({ ok: false, error: "Missing sheet name." }));
    }
    const csv = sheetToCsv(sheetName);
    if (csv == null) {
      return withCors(jsonOut({ ok: false, error: `Sheet not found: ${sheetName}` }));
    }
    return withCors(ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV));
  }
  return withCors(ContentService.createTextOutput("OK"));
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    const payload = safeJson(e && e.postData && e.postData.contents);
    const rawKind = String(payload.kind || "").toLowerCase();
    const sheetHint = String(payload.sheet || "").trim();
    const columns = Array.isArray(payload.columns) ? payload.columns.slice() : [];
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const session = payload.session || {};
    const participantId = String(session.participantId || "").trim();
    const isDetailSheet = /_details$/i.test(sheetHint);
    const isDetailColumns =
      columns.indexOf("eventIndex") >= 0 ||
      columns.indexOf("keyType") >= 0 ||
      columns.indexOf("timestampMs") >= 0;
    const kind = rawKind || (isDetailSheet || isDetailColumns ? "details" : "trials");
    const sheetName =
      kind === "tlx"
        ? sanitizeSheetName(sheetHint || "TLX")
        : kind === "details"
          ? sanitizeSheetName(sheetHint || `${participantId || "Unknown"}_details`)
          : sanitizeSheetName(sheetHint || participantId || "Unknown");
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const participantResult =
      kind === "tlx"
        ? appendRowsWithDedupByKeys(ss, sheetName, columns, rows, ["sessionId", "layoutIndex"])
        : kind === "details"
          ? appendRowsWithDedupByKeys(ss, sheetName, columns, rows, [
            "sessionId",
            "trialId",
            "eventIndex",
          ])
          : appendRowsWithDedup(ss, sheetName, columns, rows);

    return jsonOut({
      ok: true,
      sheet: sheetName,
      appended: participantResult.appended,
      skipped: participantResult.skipped,
    });
  } catch (err) {
    return jsonOut({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  } finally {
    lock.releaseLock();
  }
}

function appendRowsWithDedup(ss, sheetName, columns, rows) {
  if (!columns.length || !rows.length) {
    return { appended: 0, skipped: 0 };
  }

  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.appendRow(columns);
  }

  const sessionIdx = columns.indexOf("sessionId");
  const trialIdx = columns.indexOf("trialId");
  const canDedup = sessionIdx >= 0 && trialIdx >= 0;

  const normalizedRows = rows.map((row) => {
    const arr = Array.isArray(row) ? row : [];
    return columns.map((_, idx) => (arr[idx] !== undefined ? arr[idx] : ""));
  });

  if (!canDedup) {
    sheet.getRange(sheet.getLastRow() + 1, 1, normalizedRows.length, columns.length).setValues(normalizedRows);
    return { appended: normalizedRows.length, skipped: 0 };
  }

  const existingKeys = new Set();
  const existingLastRow = sheet.getLastRow();
  if (existingLastRow > 1) {
    const existing = sheet.getRange(2, 1, existingLastRow - 1, columns.length).getValues();
    existing.forEach((row) => {
      const key = `${String(row[sessionIdx] || "")}::${String(row[trialIdx] || "")}`;
      if (key !== "::") existingKeys.add(key);
    });
  }

  const toAppend = [];
  let skipped = 0;
  normalizedRows.forEach((row) => {
    const key = `${String(row[sessionIdx] || "")}::${String(row[trialIdx] || "")}`;
    if (key === "::") {
      toAppend.push(row);
      return;
    }
    if (existingKeys.has(key)) {
      skipped += 1;
      return;
    }
    existingKeys.add(key);
    toAppend.push(row);
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, columns.length).setValues(toAppend);
  }

  return { appended: toAppend.length, skipped };
}

function appendRowsWithDedupByKeys(ss, sheetName, columns, rows, keyColumns) {
  if (!columns.length || !rows.length) {
    return { appended: 0, skipped: 0 };
  }

  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.appendRow(columns);
  }

  const keyIdxs = keyColumns.map((key) => columns.indexOf(key)).filter((idx) => idx >= 0);
  const canDedup = keyIdxs.length > 0;

  const normalizedRows = rows.map((row) => {
    const arr = Array.isArray(row) ? row : [];
    return columns.map((_, idx) => (arr[idx] !== undefined ? arr[idx] : ""));
  });

  if (!canDedup) {
    sheet.getRange(sheet.getLastRow() + 1, 1, normalizedRows.length, columns.length).setValues(normalizedRows);
    return { appended: normalizedRows.length, skipped: 0 };
  }

  const existingKeys = new Set();
  const existingLastRow = sheet.getLastRow();
  if (existingLastRow > 1) {
    const existing = sheet.getRange(2, 1, existingLastRow - 1, columns.length).getValues();
    existing.forEach((row) => {
      const key = keyIdxs.map((idx) => String(row[idx] || "")).join("::");
      if (key.replace(/:/g, "")) existingKeys.add(key);
    });
  }

  const toAppend = [];
  let skipped = 0;
  normalizedRows.forEach((row) => {
    const key = keyIdxs.map((idx) => String(row[idx] || "")).join("::");
    if (!key.replace(/:/g, "")) {
      toAppend.push(row);
      return;
    }
    if (existingKeys.has(key)) {
      skipped += 1;
      return;
    }
    existingKeys.add(key);
    toAppend.push(row);
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, columns.length).setValues(toAppend);
  }

  return { appended: toAppend.length, skipped };
}

function listParticipantSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const out = [];
  sheets.forEach((sheet) => {
    const name = sheet.getName();
    if (name === "All_Trials") return;
    if (/_details$/i.test(name)) return;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const lastCol = sheet.getLastColumn();
    if (lastCol < 1) return;
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0] || [];
    if (headers.indexOf("sessionId") === -1 || headers.indexOf("trialId") === -1) return;
    out.push(name);
  });
  return out;
}

function sheetToCsv(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  const data = sheet.getDataRange().getDisplayValues();
  return toCsv(data);
}

function toCsv(rows) {
  const lines = rows.map((row) => row.map(escapeCsv).join(","));
  return lines.join("\r\n");
}

function escapeCsv(value) {
  const s = String(value == null ? "" : value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function safeJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch (err) {
    return {};
  }
}

function sanitizeSheetName(name) {
  const cleaned = String(name || "")
    .replace(/[\[\]\*\?\/\\:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = cleaned ? cleaned : "Unknown";
  return fallback.length > 99 ? fallback.slice(0, 99) : fallback;
}

function jsonOut(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function withCors(output) {
  if (output && typeof output.setHeader === "function") {
    output.setHeader("Access-Control-Allow-Origin", "*");
    output.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    output.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  return output;
}
