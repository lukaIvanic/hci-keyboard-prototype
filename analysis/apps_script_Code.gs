function doGet() {
  return ContentService.createTextOutput("OK");
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    const payload = safeJson(e && e.postData && e.postData.contents);
    const columns = Array.isArray(payload.columns) ? payload.columns.slice() : [];
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const session = payload.session || {};
    const participantId = String(session.participantId || "").trim();
    const sheetName = sanitizeSheetName(participantId || "Unknown");
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const participantResult = appendRowsWithDedup(ss, sheetName, columns, rows);
    const aggregateResult = appendRowsWithDedup(ss, "All_Trials", columns, rows);

    return jsonOut({
      ok: true,
      sheet: sheetName,
      appended: participantResult.appended,
      skipped: participantResult.skipped,
      aggregateAppended: aggregateResult.appended,
      aggregateSkipped: aggregateResult.skipped,
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
