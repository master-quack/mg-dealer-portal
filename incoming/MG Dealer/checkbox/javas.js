import { animate } from "https://cdn.jsdelivr.net/npm/motion@12/+esm";

const SPRING = { type: "spring", bounce: 0.1, duration: 0.25 };
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

function draw(path, show) {
  if (!path) return;
  path.hidden = !show;
  if (!show) {
    animate(path, { pathLength: 0, opacity: 0 }, reduce ? { duration: 0 } : SPRING);
    return;
  }
  if (reduce) {
    animate(path, { pathLength: 1, opacity: 1 }, { duration: 0 });
    return;
  }
  animate(path, { pathLength: [0, 1], opacity: 1 }, { ...SPRING, delay: 0.05 });
}

function sync(input) {
  const root = input.closest(".ui-checkbox");
  const icon = root.querySelector(".ui-checkbox__icon");
  const check = root.querySelector(".ui-checkbox__check");
  const dash = root.querySelector(".ui-checkbox__dash");
  const mixed = input.indeterminate;
  const on = mixed || input.checked;

  input.setAttribute("aria-checked", mixed ? "mixed" : String(input.checked));

  if (reduce) {
    animate(icon, { opacity: on ? 1 : 0, scale: 1 }, { duration: 0 });
  } else {
    animate(icon, { opacity: on ? 1 : 0, scale: on ? 1 : 0.8 }, SPRING);
  }

  draw(check, input.checked && !mixed);
  draw(dash, mixed);
}

document.querySelectorAll(".ui-checkbox__input").forEach((input) => {
  sync(input);
  input.add