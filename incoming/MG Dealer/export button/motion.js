import { animate, press } from "https://cdn.jsdelivr.net/npm/motion@12/+esm";

const SPRING = { type: "spring", stiffness: 400, damping: 30, mass: 1 };
const BUTTON_SPRING = {
  type: "spring",
  stiffness: 200,
  damping: 15,
  mass: 1.2,
  backgroundColor: { duration: 0.2 },
};

const SIZE = {
  sm: { height: 52, circle: 52, idle: 108, saved: 128 },
  md: { height: 56, circle: 56, idle: 120, saved: 140 },
  lg: { height: 68, circle: 68, idle: 144, saved: 168 },
};

function colors(status) {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (status === "loading" || status === "success") {
    return { bg: dark ? "#ffffff" : "#18181b", borderW: 0, border: "transparent" };
  }
  if (status === "saved") {
    return {
      bg: dark ? "#27272a" : "#ffffff",
      borderW: 2,
      border: dark ? "#ffffff10" : "#00000030",
    };
  }
  return {
    bg: dark ? "#27272a" : "#E8E7E0",
    borderW: 0,
    border: "transparent",
  };
}

function layer(btn, name) {
  return btn.querySelector(`[data-layer="${name}"]`);
}

async function show(el, keyframes) {
  el.hidden = false;
  await animate(el, keyframes, SPRING).finished;
}

async function hide(el, keyframes) {
  if (!el || el.hidden) return;
  await animate(el, keyframes, SPRING).finished;
  el.hidden = true;
}

function morphButton(btn, status) {
  const cfg = SIZE[btn.dataset.size] || SIZE.md;
  const isCircle = status === "loading" || status === "success";
  const { bg, borderW, border } = colors(status);
  const width = isCircle ? cfg.circle : Math.max(cfg.idle, cfg.saved);

  animate(
    btn,
    {
      width,
      height: cfg.height,
      backgroundColor: bg,
      borderWidth: borderW,
      borderColor: border,
    },
    BUTTON_SPRING
  );
}

function initExportToggle(btn, { runExport, loadingDuration = 1200, successDuration = 1000 } = {}) {
  const idle = layer(btn, "idle");
  const loading = layer(btn, "loading");
  const done = layer(btn, "done");
  const spinner = btn.querySelector(".export-toggle__spinner");
  const doneText = btn.querySelector(".export-toggle__done-text");
  let spin;
  let busy = false;

  press(btn, () => {
    animate(btn, { scale: 0.97 }, { duration: 0.12 });
    return () => animate(btn, { scale: 1 }, { type: "spring", stiffness: 400, damping: 30 });
  });

  async function setStatus(next) {
    const prev = btn.dataset.status;
    btn.dataset.status = next;
    morphButton(btn, next);

    if (prev === "idle" && next === "loading") {
      hide(idle, { opacity: 0, y: -15, x: -20 });
      await show(loading, { opacity: [0, 1], scale: [0.8, 1], filter: ["blur(4px)", "blur(0px)"] });
      spin = animate(spinner, { rotate: 360 }, { duration: 0.7, ease: "linear", repeat: Infinity });
    }

    if (prev === "loading" && next === "success") {
      spin?.stop();
      hide(loading, { opacity: 0, scale: 0.8, filter: "blur(4px)" });
      await show(done, { opacity: [0, 1], scale: [0.5, 1.15], filter: ["blur(4px)", "blur(0px)"] });
    }

    if (prev === "success" && next === "saved") {
      animate(done, { scale: 1, y: 0, opacity: 1 }, SPRING);
      if (doneText) {
        animate(doneText, { opacity: [0, 1], x: [-10, 0] }, { ...SPRING, delay: 0.1 });
      }
    }

    if (next === "idle" && prev === "saved") {
      hide(done, { opacity: 0, y: 15, filter: "blur(4px)" });
      await show(idle, { opacity: [0, 1], y: [15, 0], x: 0 });
    }
  }

  btn.addEventListener("click", async () => {
    const status = btn.dataset.status;
    if (status === "saved") {
      await setStatus("idle");
      return;
    }
    if (status !== "idle" || busy) return;

    busy = true;
    await setStatus("loading");
    try {
      if (runExport) await runExport();
      else await new Promise((r) => setTimeout(r, loadingDuration));
      await setStatus("success");
      await new Promise((r) => setTimeout(r, successDuration));
      await setStatus("saved");
    } catch (err) {
      console.error(err);
      spin?.stop();
      loading.hidden = true;
      done.hidden = true;
      idle.hidden = false;
      btn.dataset.status = "idle";
      morphButton(btn, "idle");
      animate(idle, { opacity: 1, y: 0, x: 0 }, SPRING);
      alert("Export failed. Try again.");
    } finally {
      busy = false;
    }
  });
}

const button = document.querySelector(".export-toggle");
if (button) {
  initExportToggle(button, {
    async runExport() {
      // Point this at your real export route:
      // const res = await fetch("/export", { credentials: "include" });
      // if (!res.ok) throw new Error("Export failed");
    },
  });
}