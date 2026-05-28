async function load() {
  const [statsRes, candRes] = await Promise.all([
    fetch("/api/stats"),
    fetch("/api/candidates?limit=200"),
  ]);
  const stats = await statsRes.json();
  const { candidates } = await candRes.json();

  document.getElementById("stats").innerHTML = [
    ["Candidats", stats.totalCandidates],
    ["En attente", stats.pending],
    ["Scans", stats.totalRuns],
  ]
    .map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`)
    .join("");

  const list = document.getElementById("list");
  const render = (filter) => {
    const f = filter.trim().toLowerCase();
    list.innerHTML = candidates
      .filter((c) => !f || c.title.toLowerCase().includes(f))
      .map((c) => {
        const tjm = c.tjm
          ? `<span class="${c.lowball ? "low" : "tjm"}">${c.tjm}€/j</span> · `
          : "";
        return `<div class="card">
            <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a>
            <div class="meta">${tjm}${escapeHtml(c.source)} · ${escapeHtml(String(c.postedAt ?? c.fetchedAt))}</div>
          </div>`;
      })
      .join("");
  };

  document.getElementById("q").addEventListener("input", (e) => render(e.target.value));
  render("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

load();
