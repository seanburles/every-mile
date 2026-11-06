// In-app setup: your name, a Garmin Personal API key and/or a Strava archive, with live progress.
// Talks to the dev-server endpoints in vite.config.js, so it only exists under `npm run dev`
// (`npm run setup` does the same from a terminal).
import { $ } from "./shared.js";

const esc = (s = "") => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function openWizard({ profile, demo }) {
  const el = $("wizard");
  el.hidden = false;
  el.innerHTML = `
    <div class="wiz" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
      <header><h2 id="wiz-title">${demo ? "Use your own activities" : "Your data"}</h2><button class="x" data-wiz-close aria-label="Close">×</button></header>
      <form class="wiz-body">
        <fieldset>
          <legend>Your name</legend>
          <input name="who" type="text" autocomplete="name" placeholder="e.g. Alex Rivera" value="${esc(profile?.demo ? "" : profile?.name)}" />
          <label class="switch"><input name="showName" type="checkbox" ${profile?.showName && !profile?.demo ? "checked" : ""} /><span></span>
            Show my name on the page <small>Under the title and in the tab. Your activities already link to your Garmin or Strava profile.</small></label>
        </fieldset>

        <fieldset>
          <legend>Garmin Connect</legend>
          <p>Create a Personal API key at <a href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noopener">connect.garmin.com → Personal API token ↗</a>
            and paste it here. It's saved to <code>.env</code> on this computer only.</p>
          <input name="key" type="password" autocomplete="off" placeholder="Paste your key (optional)" />
        </fieldset>

        <fieldset>
          <legend>Strava export</legend>
          <p>Strava → Settings → My Account → <b>Download or Delete Your Account</b> → Request your archive. Strava emails you a .zip.</p>
          <label class="drop"><input name="zip" type="file" accept=".zip,application/zip" /><span>Drop the .zip here or <u>choose it</u></span></label>
        </fieldset>

        ${demo ? `<p class="note">The demo athlete is replaced once your activities are in.</p>` : ""}
        <footer><button type="submit" class="go">Save</button></footer>
      </form>
      <div class="wiz-run" hidden><p class="status"></p><pre class="log"></pre><footer></footer></div>
    </div>`;

  const form = el.querySelector("form");
  const go = form.querySelector(".go");
  const drop = form.querySelector(".drop span");
  const label = () => {
    const importing = form.key.value.trim() || form.zip.files[0];
    go.textContent = importing ? "Import my activities →" : "Save";
  };
  form.addEventListener("input", label);
  form.zip.addEventListener("change", () => {
    const f = form.zip.files[0];
    drop.innerHTML = f ? `<b>${esc(f.name)}</b> · ${(f.size / 1e6).toFixed(0)} MB` : "Drop the .zip here or <u>choose it</u>";
    label();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(el, {
      name: form.who.value,
      showName: form.showName.checked,
      key: form.key.value.trim(),
      zip: form.zip.files[0],
    });
  });
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-wiz-close]")) close();
  });
  form.who.focus();
}

function close() {
  const el = $("wizard");
  if (el.querySelector(".wiz-run:not([hidden]) .busy")) return; // don't walk away from a running import
  el.hidden = true;
  el.innerHTML = "";
}

async function run(el, { name, showName, key, zip }) {
  const runEl = el.querySelector(".wiz-run");
  const status = runEl.querySelector(".status");
  const log = runEl.querySelector(".log");
  const foot = runEl.querySelector("footer");
  el.querySelector("form").hidden = true;
  runEl.hidden = false;

  await fetch("/api/profile", { method: "POST", body: JSON.stringify({ name, showName }) });
  if (!key && !zip) return location.reload();

  const lines = [""];
  const write = (text) => {
    // progress lines rewrite themselves with \r, like they do in a terminal
    for (const ch of text.split(/(\r|\n)/)) {
      if (ch === "\n") lines.push("");
      else if (ch === "\r") lines[lines.length - 1] = "";
      else lines[lines.length - 1] += ch;
    }
    log.textContent = lines.filter((l, i) => l || i === lines.length - 1).slice(-14).join("\n");
    log.scrollTop = log.scrollHeight;
  };
  const step = async (label, url, body) => {
    status.innerHTML = `<span class="busy"></span>${label}`;
    const res = await fetch(url, { method: "POST", body });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      all += s;
      write(s.replace(/\n__EXIT \d+\n$/, ""));
    }
    const code = Number(all.match(/__EXIT (\d+)/)?.[1] ?? 1);
    // the scripts end with "Error: <what went wrong>"; lead with that rather than the stack trace
    const why = [...all.matchAll(/^Error: (.+)$/gm)].at(-1)?.[1];
    if (code) throw new Error(why ? `Stopped: ${why}` : "That step stopped with an error (see the log).");
  };

  try {
    if (key) await step("Pulling your Garmin history. The first run downloads every GPS file, so a long history takes a while…", "/api/setup/garmin", JSON.stringify({ key }));
    if (zip) await step("Importing your Strava archive…", "/api/setup/strava", zip);
    status.textContent = "Done. Loading your map…";
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    status.textContent = e.message;
    foot.innerHTML = `<button class="go" data-wiz-close>Close</button>`;
  }
}
