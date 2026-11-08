// Share row at the bottom of the panel: X, Facebook, Reddit, Instagram, copy link (and the phone's own share
// sheet where there is one). Instagram can't take a link from the web, so its button opens the cards drawn at
// build time (scripts/og.mjs): share one straight to Instagram on a phone, or save it on a computer.
import { siX, siFacebook, siReddit, siInstagram, siGithub } from "simple-icons";
import { $ } from "./shared.js";

// where the code lives, for anyone who wants their own map
const REPO = "https://github.com/seanburles/every-mile";

const icon = (si) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${si.path}"/></svg>`;

// the published address (publish.mjs writes a canonical link); locally, whatever this is
const pageUrl = () => document.querySelector('link[rel="canonical"]')?.href ?? `${location.origin}${location.pathname}`;
const blurb = () => document.querySelector('meta[name="description"]')?.content ?? document.title;

export function renderShare(host) {
  host.innerHTML = `
    <h2>Share</h2>
    <div class="share-row">
      <button data-share="x" aria-label="Share on X" title="X">${icon(siX)}</button>
      <button data-share="facebook" aria-label="Share on Facebook" title="Facebook">${icon(siFacebook)}</button>
      <button data-share="reddit" aria-label="Share on Reddit" title="Reddit">${icon(siReddit)}</button>
      <button data-share="instagram" aria-label="Instagram cards" title="Instagram">${icon(siInstagram)}</button>
      <button data-share="copy" class="txt">Copy link</button>
      ${navigator.share ? `<button data-share="native" class="txt">Share…</button>` : ""}
    </div>
    <a class="repo" href="${REPO}" target="_blank" rel="noopener">${icon(siGithub)}<span>Make your own map · <b>every-mile</b> on GitHub ↗</span></a>`;
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-share]");
    if (b) share(b.dataset.share, b);
  });
}

function share(kind, btn) {
  const url = pageUrl(), text = blurb(), u = encodeURIComponent(url);
  const open = (href) => window.open(href, "_blank", "noopener,width=640,height=640");
  if (kind === "x") return open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${u}`);
  if (kind === "facebook") return open(`https://www.facebook.com/sharer/sharer.php?u=${u}`);
  if (kind === "reddit") return open(`https://www.reddit.com/submit?url=${u}&title=${encodeURIComponent(document.title)}`);
  if (kind === "native") return navigator.share({ title: document.title, text, url }).catch(() => {});
  if (kind === "copy") {
    return navigator.clipboard.writeText(url).then(() => {
      btn.textContent = "Copied ✓";
      setTimeout(() => (btn.textContent = "Copy link"), 1600);
    });
  }
  if (kind === "instagram") return openCards();
}

async function openCards() {
  const el = $("cards");
  const data = await fetch("data/cards/cards.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const cards = data?.cards ?? [];
  const src = (c) => `data/cards/${c.id}.png?v=${data.v}`;
  el.hidden = false;
  el.innerHTML = `
    <div class="wiz cards" role="dialog" aria-modal="true" aria-labelledby="cards-title">
      <header><h2 id="cards-title">Share to Instagram</h2><button class="x" data-cards-close aria-label="Close">×</button></header>
      <div class="wiz-body">
        ${cards.length ? `<p>${canShareFiles() ? "Tap a card to share it to your story or feed." : "Save a card, then post it from your phone. Stories are 9:16, the feed post is 4:5."}</p>
        <ul class="card-grid">${cards.map((c) => `
          <li><button data-card="${c.id}" data-title="${c.title}"><img src="${src(c)}" alt="${c.title} card" loading="lazy" /></button>
            <span>${c.title} <small>${c.size}</small></span></li>`).join("")}</ul>`
        : `<p>No cards yet. They're drawn when the data is built: run <code>npm run build:data</code>.</p>`}
      </div>
    </div>`;
  el.onclick = async (e) => {
    if (e.target === el || e.target.closest("[data-cards-close]")) return close();
    const b = e.target.closest("[data-card]");
    if (!b) return;
    const name = `every-mile-${b.dataset.card}.png`;
    const blob = await fetch(src({ id: b.dataset.card })).then((r) => r.blob());
    const file = new File([blob], name, { type: "image/png" });
    if (canShareFiles(file)) return navigator.share({ files: [file], title: document.title }).catch(() => {});
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  el.querySelector("[data-cards-close]").focus();
}

// phones can hand an image to Instagram through the share sheet; desktops save it instead
function canShareFiles(file = new File([""], "x.png", { type: "image/png" })) {
  return Boolean(navigator.canShare?.({ files: [file] })) && matchMedia("(pointer: coarse)").matches;
}

function close() {
  const el = $("cards");
  el.hidden = true;
  el.innerHTML = "";
}

export const cardsOpen = () => !$("cards").hidden;
export const closeCards = close;
