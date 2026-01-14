(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  function escapeCsv(value) {
    const s = String(value ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  }

  function toCsv(rows, columns) {
    const cols = columns.slice();
    const lines = [];
    lines.push(cols.map(escapeCsv).join(","));
    for (const row of rows) {
      lines.push(cols.map((c) => escapeCsv(row[c])).join(","));
    }
    return lines.join("\r\n");
  }

  function downloadTextFile({ filename, mime, content }) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function downloadCsv(filename, rows, columns) {
    const csv = toCsv(rows, columns);
    downloadTextFile({ filename, mime: "text/csv;charset=utf-8", content: csv });
  }

  function downloadJson(filename, data) {
    const json = JSON.stringify(data, null, 2);
    downloadTextFile({ filename, mime: "application/json;charset=utf-8", content: json });
  }

  ns.exporting = {
    toCsv,
    downloadCsv,
    downloadJson,
  };
})();

