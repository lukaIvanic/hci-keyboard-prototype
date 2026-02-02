(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderKeyboard(containerEl, layout, onKey) {
    clear(containerEl);
    if (!layout) return;

    const bounds = ns.layouts.getLayoutBounds(layout);
    const paddingPx = 10;
    const gapPx = 0;
    const usableWidthPx = Math.max(200, containerEl.clientWidth - paddingPx * 2);
    const unitPx = usableWidthPx / bounds.width;

    containerEl.style.height = `${Math.ceil(bounds.height * unitPx + paddingPx * 2)}px`;

    for (const key of layout.keys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "key";
      if (key.w > 1.25 || key.type !== "char") btn.classList.add("keyWide");
      if (key.type === "enter") btn.classList.add("keyAction");

      btn.textContent = key.label;
      btn.setAttribute("data-key-id", key.id);
      btn.setAttribute("aria-label", key.type === "char" ? `Key ${key.label}` : key.label);
      if (key.type === "enter") btn.id = "submitTrialBtn";

      const left = paddingPx + (key.x - bounds.minX) * unitPx + gapPx / 2;
      const top = paddingPx + (key.y - bounds.minY) * unitPx + gapPx / 2;
      const width = key.w * unitPx - gapPx;
      const height = key.h * unitPx - gapPx;

      btn.style.left = `${left}px`;
      btn.style.top = `${top}px`;
      // IMPORTANT: Do not clamp min pixel sizes here.
      // Clamping breaks the no-overlap guarantees from the layout generator.
      btn.style.width = `${width}px`;
      btn.style.height = `${height}px`;

      let lastPointerDownAt = 0;
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        lastPointerDownAt = Date.now();
        onKey(key);
      });
      btn.addEventListener("click", (e) => {
        // Fallback for browsers where pointer events are missing/quirky.
        if (Date.now() - lastPointerDownAt < 500) return;
        e.preventDefault();
        onKey(key);
      });

      containerEl.appendChild(btn);
    }
  }

  ns.keyboard = {
    renderKeyboard,
  };
})();

