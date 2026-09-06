/* Shared JS for Suwu website — lightbox, copy-to-clipboard, footer year.
 * Used by both the landing page and docs. */

(function () {
  'use strict';

  // ── Footer year ────────────────────────────────────────────────────────────
  var yearEl = document.getElementById('footer-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ── Lightbox ───────────────────────────────────────────────────────────────
  var lightbox = document.getElementById('lightbox');
  if (lightbox) {
    var lbVideo    = document.getElementById('lightbox-video');
    var closeBtn   = lightbox.querySelector('.lightbox-close');
    var lastFocus  = null;

    function lbOpen(src, label) {
      lastFocus = document.activeElement;
      lbVideo.src = src;
      lbVideo.setAttribute('aria-label', label || '');
      lightbox.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      lbVideo.play();
      closeBtn.focus();
    }

    function lbClose() {
      lbVideo.pause();
      lbVideo.removeAttribute('src');
      lightbox.classList.remove('is-open');
      document.body.style.overflow = '';
      if (lastFocus) lastFocus.focus();
    }

    // Attach to every clickable video
    document.querySelectorAll('.doc-video video, .feature-media-video').forEach(function (vid) {
      vid.style.cursor = 'pointer';
      vid.setAttribute('tabindex', '0');
      vid.setAttribute('role', 'button');
      vid.setAttribute('aria-label', (vid.getAttribute('aria-label') || 'Demo') + ' — click to enlarge');
      vid.addEventListener('click', function () { lbOpen(vid.src, vid.getAttribute('aria-label')); });
      vid.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lbOpen(vid.src, vid.getAttribute('aria-label')); }
      });
    });

    closeBtn.addEventListener('click', lbClose);
    lightbox.addEventListener('click', function (e) { if (e.target === lightbox) lbClose(); });
    document.addEventListener('keydown', function (e) {
      if (lightbox.classList.contains('is-open') && e.key === 'Escape') lbClose();
    });
  }

  // ── Copy to clipboard (code blocks) ────────────────────────────────────────
  document.querySelectorAll('.prose pre').forEach(function (pre) {
    var btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.textContent = 'Copy';
    pre.style.position = 'relative';
    pre.appendChild(btn);

    btn.addEventListener('click', function () {
      var code = pre.querySelector('code');
      var text = (code || pre).textContent.replace(/Copy$/, '').trim();
      function done(ok) {
        btn.textContent = ok ? 'Copied!' : 'Failed';
        btn.classList.add('code-copy-btn-done');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('code-copy-btn-done'); }, 2000);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      }
    });
  });

})();
