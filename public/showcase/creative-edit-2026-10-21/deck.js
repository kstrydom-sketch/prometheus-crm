(() => {
  'use strict';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const behavior = () => reducedMotion.matches ? 'instant' : 'smooth';
  const videos = [...document.querySelectorAll('video')];
  // Links to the former presentation now open the same one-page collection.
  if (/^#\d+$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);

  document.querySelectorAll('[data-gallery]').forEach(gallery => {
    const track = gallery.querySelector('.track');
    const cards = [...track.querySelectorAll('.creative')];
    const previous = gallery.querySelector('[data-prev]');
    const next = gallery.querySelector('[data-next]');
    const dots = gallery.querySelector('.gallery-dots');
    let current = 0;
    let pending = false;
    const position = card => card.getBoundingClientRect().left - track.getBoundingClientRect().left + track.scrollLeft - parseFloat(getComputedStyle(track).paddingLeft);
    const navigate = index => {
      const target = Math.max(0, Math.min(cards.length - 1, index));
      track.scrollTo({ left: position(cards[target]), behavior: behavior() });
    };
    cards.forEach((card, index) => {
      const dot = document.createElement('button');
      dot.setAttribute('aria-label', `Show ${card.getAttribute('aria-label').toLowerCase()}`);
      dot.addEventListener('click', () => navigate(index));
      dots.append(dot);
    });
    const update = () => {
      const distances = cards.map(card => Math.abs(position(card) - track.scrollLeft));
      current = distances.indexOf(Math.min(...distances));
      previous.disabled = current === 0;
      next.disabled = current === cards.length - 1;
      gallery.querySelector('.gallery-count').textContent = `${String(current + 1).padStart(2, '0')} / ${String(cards.length).padStart(2, '0')}`;
      [...dots.children].forEach((dot, index) => dot.setAttribute('aria-current', String(index === current)));
      pending = false;
    };
    track.addEventListener('scroll', () => { if (!pending) { pending = true; requestAnimationFrame(update); } }, { passive: true });
    previous.addEventListener('click', () => navigate(current - 1));
    next.addEventListener('click', () => navigate(current + 1));
    track.addEventListener('keydown', event => {
      if (event.target.closest('video') || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(current + 1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(current - 1); }
      if (event.key === 'Home') { event.preventDefault(); navigate(0); }
      if (event.key === 'End') { event.preventDefault(); navigate(cards.length - 1); }
    });
    new ResizeObserver(update).observe(track);
    update();
  });

  videos.forEach(video => {
    const play = document.createElement('button');
    play.className = 'play-video';
    play.setAttribute('aria-label', `Play ${video.getAttribute('aria-label')}`);
    const poster = document.createElement('img');
    poster.src = video.poster;
    poster.alt = '';
    const symbol = document.createElement('span');
    symbol.className = 'play-symbol';
    symbol.textContent = '▶';
    symbol.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'play-label';
    label.textContent = 'PLAY FILM';
    play.append(poster, symbol, label);
    video.parentElement.append(play);
    video.tabIndex = -1;
    play.addEventListener('click', async () => {
      play.disabled = true;
      label.textContent = 'LOADING…';
      try {
        await video.play();
      } catch {
        label.textContent = 'TRY AGAIN';
        play.disabled = false;
      }
    });
    video.addEventListener('playing', () => {
      const hadFocus = document.activeElement === play;
      play.hidden = true;
      play.disabled = false;
      video.tabIndex = 0;
      if (hadFocus) video.focus({ preventScroll: true });
    });
    video.addEventListener('ended', () => {
      play.hidden = false;
      label.textContent = 'REPLAY FILM';
      video.tabIndex = -1;
    });
    video.addEventListener('play', () => {
      videos.forEach(other => { if (other !== video) other.pause(); });
    });
  });
  // Pause when the viewer swipes away or scrolls down to the static collection.
  const videoVisibility = new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.intersectionRatio < .35) entry.target.pause(); });
  }, { threshold: [0, .35] });
  videos.forEach(video => videoVisibility.observe(video));
  document.addEventListener('visibilitychange', () => { if (document.hidden) videos.forEach(video => video.pause()); });

  const lightbox = document.querySelector('#lightbox');
  const image = document.querySelector('#lightbox-image');
  const imageButtons = [...document.querySelectorAll('[data-image]')];
  let imageIndex = 0;
  function showImage(index) {
    imageIndex = Math.max(0, Math.min(imageButtons.length - 1, index));
    const button = imageButtons[imageIndex];
    image.src = button.querySelector('img').src;
    image.alt = button.querySelector('img').alt;
    document.querySelector('#original-link').href = image.src;
    document.querySelector('#lightbox-title').textContent = button.closest('article').querySelector('h3').textContent;
    document.querySelector('#lightbox-count').textContent = `${String(imageIndex + 1).padStart(2, '0')} / ${String(imageButtons.length).padStart(2, '0')}`;
    document.querySelector('#image-prev').disabled = imageIndex === 0;
    document.querySelector('#image-next').disabled = imageIndex === imageButtons.length - 1;
  }
  imageButtons.forEach((button, index) => button.addEventListener('click', () => {
    videos.forEach(video => video.pause());
    showImage(index);
    lightbox.showModal();
    document.body.style.overflow = 'hidden';
  }));
  lightbox.addEventListener('close', () => { document.body.style.overflow = ''; });
  document.querySelector('#lightbox-close').addEventListener('click', () => lightbox.close());
  document.querySelector('#image-prev').addEventListener('click', () => showImage(imageIndex - 1));
  document.querySelector('#image-next').addEventListener('click', () => showImage(imageIndex + 1));
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); showImage(imageIndex + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); showImage(imageIndex - 1); }
  });
  lightbox.addEventListener('click', event => {
    if (event.target !== lightbox) return;
    const rect = lightbox.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) lightbox.close();
  });
  let touch = null;
  image.addEventListener('touchstart', event => { touch = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }, { passive: true });
  image.addEventListener('touchend', event => {
    if (!touch) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) showImage(imageIndex + (dx < 0 ? 1 : -1));
    touch = null;
  }, { passive: true });
  image.addEventListener('touchcancel', () => { touch = null; }, { passive: true });
})();
