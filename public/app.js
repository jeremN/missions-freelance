async function load() {
  try {
    const [statsRes, candRes, missionsRes] = await Promise.all([
      fetch("/api/stats"),
      fetch("/api/candidates?limit=200"),
      fetch("/api/missions?limit=200"),
    ]);
    if (!statsRes.ok || !candRes.ok || !missionsRes.ok) {
      throw new Error(
        `api error: stats=${statsRes.status} candidates=${candRes.status} missions=${missionsRes.status}`,
      );
    }
    const stats = await statsRes.json();
    const { candidates } = await candRes.json();
    const { missions } = await missionsRes.json();

    document.getElementById("stats").innerHTML = [
      ["Candidats", stats.totalCandidates],
      ["En attente", stats.pending],
      ["Scans", stats.totalRuns],
    ]
      // Even though `l` and `v` are own-API values, escape both for consistency
      // with the cards below — a future schema change shouldn't open an XSS hole.
      .map(
        ([l, v]) =>
          `<div class="stat"><div class="v">${escapeHtml(String(v))}</div><div class="l">${escapeHtml(String(l))}</div></div>`,
      )
      .join("");

    const missionsEl = document.getElementById("missions");
    const scoreClass = (s) => (s >= 80 ? "hi" : s >= 50 ? "mid" : "lo");
    const renderMissions = (filter) => {
      const f = filter.trim().toLowerCase();
      missionsEl.innerHTML = missions
        .filter((m) => !f || m.title.toLowerCase().includes(f))
        .map((m) => {
          const tjm = m.rateEurDay
            ? `<span class="tjm">${escapeHtml(String(m.rateEurDay))}€/j</span> · `
            : "";
          const loc = m.location ? `${escapeHtml(m.location)} · ` : "";
          return `<div class="card">
              <span class="score ${scoreClass(m.score)}">${escapeHtml(String(m.score))}</span>
              <a href="${escapeHtml(safeUrl(m.url))}" target="_blank" rel="noopener">${escapeHtml(m.title)}</a>
              <div class="meta">${tjm}${escapeHtml(m.remote)} · ${escapeHtml(m.clientType)} · ${loc}${escapeHtml(m.reason || "")}</div>
            </div>`;
        })
        .join("");
    };
    document
      .getElementById("qm")
      .addEventListener("input", (e) => renderMissions(e.target.value));
    renderMissions("");

    const list = document.getElementById("list");
    const render = (filter) => {
      const f = filter.trim().toLowerCase();
      list.innerHTML = candidates
        .filter((c) => !f || c.title.toLowerCase().includes(f))
        .map((c) => {
          const tjm = c.tjm
            ? `<span class="${c.lowball ? "low" : "tjm"}">${escapeHtml(String(c.tjm))}€/j</span> · `
            : "";
          return `<div class="card">
              <a href="${escapeHtml(safeUrl(c.url))}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a>
              <div class="meta">${tjm}${escapeHtml(c.source)} · ${escapeHtml(String(c.postedAt ?? c.fetchedAt))}</div>
            </div>`;
        })
        .join("");
    };

    document.getElementById("q").addEventListener("input", (e) => render(e.target.value));
    render("");
  } catch (err) {
    const list = document.getElementById("list");
    list.textContent = `Chargement échoué: ${err && err.message ? err.message : err}`;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/**
 * Allow only http/https URLs in href — escapeHtml defuses HTML injection but
 * doesn't block dangerous schemes (javascript:, data:, vbscript:). Today the
 * only adapter (Reddit) path-prefixes URLs so this is harmless; the moment M2
 * adds adapters that pass through feed URLs directly, this guard becomes the
 * thing that prevents `<a href="javascript:...">` from rendering.
 */
function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : "#";
}

load();
