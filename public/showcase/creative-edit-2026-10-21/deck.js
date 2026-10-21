(() => {
  'use strict';
  const slides = [...document.querySelectorAll('.slide')];
  const dots = document.querySelector('#dots');
  const index = document.querySelector('#index');
  const indexToggle = document.querySelector('#index-toggle');
  const indexList = document.querySelector('#index-list');
  const lightbox = document.querySelector('#lightbox');
  const lightboxImage = document.querySelector('#lightbox-image');
  let current = 0;
  function fromHash() {
    const value = Number(location.hash.slice(1));
    return Number.isInteger(value) && value >= 1 && value <= slides.length ? value - 1 : 0;
  }
  function go(next, updateHash = true) {
    current = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach((slide, i) => {
      slide.hidden = i !== current;
      slide.classList.toggle('active', i === current);
      if (i !== current) slide.querySelectorAll('video').forEach(video => video.pause());
    });
    [...dots.children].forEach((button, i) => button.setAttribute('aria-current', String(i === current)));
    [...indexList.children].forEach((button, i) => button.setAttribute('aria-current', String(i === current)));
    document.querySelector('#counter').textContent = `${String(current + 1).padStart(2, '0')} / ${slides.length}`;
    document.querySelector('#progress-fill').style.width = `${((current + 1) / slides.length) * 100}%`;
    document.querySelector('#prev').disabled = current === 0;
    document.querySelector('#next').disabled = current === slides.length - 1;
    document.querySelector('#section-label').textContent = current === 0 ? 'THE COLLECTION' : current < 6 ? 'STATIC CREATIVE' : current < 9 ? 'MOTION CREATIVE' : 'CREATIVE PATTERNS';
    document.title = `${slides[current].dataset.title} · CTC Creative Edit`;
    document.querySelector('#status').textContent = `Slide ${current + 1} of ${slides.length}: ${slides[current].dataset.title}`;
    if (updateHash) history.replaceState(null, '', `#${current + 1}`);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  slides.forEach((slide, i) => {
    const dot = document.createElement('button');
    dot.setAttribute('aria-label', `Slide ${i + 1}: ${slide.dataset.title}`);
    dot.addEventListener('click', () => go(i));
    dots.append(dot);
    const item = document.createElement('button');
    const number = document.createElement('span');
    number.textContent = String(i + 1).padStart(2, '0');
    item.append(number, document.createTextNode(slide.dataset.title));
    item.addEventListener('click', () => { index.close(); go(i); });
    indexList.append(item);
  });
  document.querySelector('#prev').addEventListener('click', () => go(current - 1));
  document.querySelector('#next').addEventListener('click', () => go(current + 1));
  document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => go(Number(button.dataset.go))));
  indexToggle.addEventListener('click', () => { index.showModal(); indexToggle.setAttribute('aria-expanded', 'true'); });
  document.querySelector('#index-close').addEventListener('click', () => index.close());
  index.addEventListener('close', () => indexToggle.setAttribute('aria-expanded', 'false'));
  document.querySelectorAll('[data-image]').forEach(button => button.addEventListener('click', () => {
    lightboxImage.src = `creative-edit-2026-10-21/assets/${button.dataset.image}`;
    lightboxImage.alt = button.querySelector('img').alt;
    document.querySelector('#original-link').href = lightboxImage.src;
    lightbox.showModal();
  }));
  document.querySelector('#lightbox-close').addEventListener('click', () => lightbox.close());
  [index, lightbox].forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
  document.querySelector('#fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { document.querySelector('#status').textContent = 'Fullscreen is unavailable in this browser. Use the browser fullscreen command to present.'; }
  });
  document.addEventListener('fullscreenchange', () => {
    const button = document.querySelector('#fullscreen');
    button.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
    button.innerHTML = document.fullscreenElement ? 'Exit <span aria-hidden="true">↙</span>' : 'Present <span aria-hidden="true">↗</span>';
  });
  document.addEventListener('keydown', event => {
    if (index.open || lightbox.open || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest('video, input, textarea, select')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); go(current + 1); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(current - 1); }
    if (event.key === 'Home') { event.preventDefault(); go(0); }
    if (event.key === 'End') { event.preventDefault(); go(slides.length - 1); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) document.querySelectorAll('video').forEach(video => video.pause()); });
  let touch = null;
  document.querySelector('#deck').addEventListener('touchstart', event => {
    if (event.target.closest('video, button, a')) return;
    touch = { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
  }, { passive: true });
  document.querySelector('#deck').addEventListener('touchend', event => {
    if (!touch) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) go(current + (dx < 0 ? 1 : -1));
    touch = null;
  }, { passive: true });
  window.addEventListener('hashchange', () => go(fromHash(), false));
  go(fromHash(), false);
})();
