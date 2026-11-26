// Makes the Okendo reviews "Show More" button work on the static Traced product pages.
// Each click reveals 5 more reviews, loaded live from the Okendo API (including reviews
// newer than the copied page). Once every review is showing, the button becomes
// "View Less", which collapses back to the reviews the page started with.
(function () {
  var API = 'https://api.okendo.io/v1';
  var STEP = 5;

  function init() {
    var widget = document.querySelector('[data-oke-widget]');
    var button = widget && widget.querySelector('.oke-showMore-button');
    var list = widget && widget.querySelector('.oke-w-reviews-list');
    var dataEl = document.querySelector('script[data-oke-metafield-data]');
    if (!button || !list || !dataEl) return;

    var data;
    try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
    // Start from the first page (drop the saved cursor) so reviews posted after the copy was made are included.
    var nextUrl = data.reviewsNextUrl ? data.reviewsNextUrl.replace(/&lastEvaluated=[^&]*/, '') : null;
    var shown = {};
    (data.reviews || []).forEach(function (r) { shown[r.reviewId] = true; });
    var queue = [];   // fetched, not yet on the page
    var extra = [];   // cards added by this script, in order
    var collapsed = false;

    var cards = list.querySelectorAll('.oke-w-reviews-list-item');
    var template = null;
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i].querySelector('.oke-w-review--featuredMedia')) { template = cards[i]; break; }
    }
    if (!template) template = cards[0];
    if (!template) return;
    var verifiedBadge = list.querySelector('.oke-w-reviewer-verified');

    var isArabic = document.documentElement.lang.indexOf('ar') === 0;
    var labelEl = button.querySelector('.oke-showMore-button-text');
    var MORE = labelEl ? labelEl.textContent : ' Show More ';
    var LESS = isArabic ? ' عرض أقل ' : ' View Less ';
    var LOADING = isArabic ? ' جارٍ التحميل… ' : ' Loading... ';
    var status = widget.querySelector('span[role="status"]');
    var mode = 'more';

    if (!nextUrl) { button.parentNode.hidden = true; return; }

    function setMode(m) {
      mode = m;
      if (labelEl) labelEl.textContent = m === 'less' ? LESS : MORE;
      button.setAttribute('aria-label', m === 'less'
        ? (isArabic ? 'عرض مراجعات أقل' : 'Show fewer reviews')
        : (isArabic ? 'عرض المزيد من المراجعات' : 'Show more reviews'));
    }

    function hiddenCards() { return extra.filter(function (c) { return c.hidden; }); }
    function hasMore() { return hiddenCards().length > 0 || queue.length > 0 || !!nextUrl; }

    function fetchPage() {
      return fetch(nextUrl)
        .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
        .then(function (page) {
          (page.reviews || []).forEach(function (r) {
            if (shown[r.reviewId]) return;
            shown[r.reviewId] = true;
            queue.push(r);
          });
          nextUrl = page.nextUrl ? (/^https?:/.test(page.nextUrl) ? page.nextUrl : API + page.nextUrl) : null;
        });
    }

    // Fetch until there are enough new reviews for one step, or nothing is left.
    function fill() {
      if (queue.length >= STEP || !nextUrl) return Promise.resolve();
      return fetchPage().then(fill);
    }

    function showMore() {
      var revealed = 0;
      hiddenCards().slice(0, STEP).forEach(function (c) { c.hidden = false; revealed++; });
      if (revealed >= STEP) return Promise.resolve(revealed);
      return fill().then(function () {
        queue.splice(0, STEP - revealed).forEach(function (r) {
          var card = buildCard(r);
          list.appendChild(card);
          extra.push(card);
          revealed++;
        });
        return revealed;
      });
    }

    function viewLess() {
      extra.forEach(function (c) { c.hidden = true; });
      setMode('more');
      widget.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (status) status.textContent = isArabic ? 'تم إخفاء المراجعات الإضافية' : 'Extra reviews hidden';
    }

    button.addEventListener('click', function () {
      if (button.disabled) return;
      if (mode === 'less') { viewLess(); return; }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      if (labelEl) labelEl.textContent = LOADING;

      showMore()
        .then(function (n) {
          if (status) status.textContent = n + (isArabic ? ' مراجعات إضافية' : ' more reviews shown');
          // Look ahead so the label is right: "View Less" only once nothing is left to show.
          return queue.length || !nextUrl ? null : fill();
        })
        .catch(function () {
          if (status) status.textContent = isArabic ? 'تعذّر تحميل المزيد من المراجعات' : 'Could not load more reviews';
        })
        .then(function () {
          button.disabled = false;
          button.removeAttribute('aria-busy');
          setMode(hasMore() ? 'more' : 'less');
          if (mode === 'less' && extra.length === 0) button.parentNode.hidden = true;
        });
    });

    function buildCard(r) {
      var card = template.cloneNode(true);
      var name = (r.reviewer && r.reviewer.displayName) || (isArabic ? 'مجهول' : 'Anonymous');
      var oldName = text(card, '.oke-w-reviewer-name');

      var review = card.querySelector('.oke-w-review');
      if (review) review.classList.remove('oke-w-review--featuredMedia');
      var main = card.querySelector('.oke-w-review-main');
      if (main) main.removeAttribute('style');
      remove(card, '.oke-w-review-featuredMedia, .oke-w-review-media, .oke-reviewContent-readMore');

      set(card, '.oke-avatar-placeholder', ' ' + name.charAt(0).toUpperCase() + ' ');
      set(card, '.oke-w-reviewer-name', ' ' + name + ' ');
      remove(card, '.oke-w-reviewer-verified');
      var identity = card.querySelector('.oke-w-reviewer-identity');
      if (r.reviewer && r.reviewer.isVerified && verifiedBadge && identity) {
        identity.parentNode.insertBefore(verifiedBadge.cloneNode(true), identity.nextSibling);
      }
      if (!r.isRecommended) remove(card, '.oke-w-review-recommendation');

      var rating = Math.max(0, Math.min(5, r.rating || 0));
      var fg = card.querySelector('.oke-stars-foreground');
      if (fg) fg.style.width = (rating / 5 * 100) + '%';
      var stars = card.querySelector('.oke-reviewContent-stars .oke-a11yText');
      if (stars) stars.textContent = stars.textContent.replace(/\d+/, rating);

      set(card, '.oke-reviewContent-date span', relativeDate(r.dateCreated));

      var title = card.querySelector('.oke-reviewContent-title');
      if (title) { title.textContent = r.title || ''; title.dir = 'auto'; }
      var body = card.querySelector('.oke-reviewContent-body');
      if (body) {
        body.textContent = '';
        body.dir = 'auto';
        String(r.body || '').split(/\n+/).forEach(function (para) {
          if (!para.trim()) return;
          var p = document.createElement('p');
          p.textContent = para;
          body.appendChild(p);
        });
      }

      var counters = card.querySelectorAll('.oke-helpful-vote-counter');
      [r.helpfulCount, r.unhelpfulCount].forEach(function (count, n) {
        var c = counters[n];
        if (!c) return;
        c.id = c.id.replace(/[0-9a-f-]{36}$/, r.reviewId);
        c.childNodes.forEach(function (node) {
          if (node.nodeType === 3 && /\d/.test(node.textContent)) node.textContent = ' ' + (count || 0) + ' ';
          if (node.nodeType === 1 && oldName) node.textContent = node.textContent.replace(oldName.trim(), name);
        });
      });
      return card;
    }

    function relativeDate(iso) {
      var days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
      var fmt = new Intl.RelativeTimeFormat(isArabic ? 'ar-u-nu-latn' : 'en', { numeric: 'auto' });
      if (days < 7) return fmt.format(-days, 'day');
      if (days < 30) return fmt.format(-Math.floor(days / 7), 'week');
      if (days < 365) return fmt.format(-Math.floor(days / 30), 'month');
      return fmt.format(-Math.floor(days / 365), 'year');
    }
  }

  function text(root, sel) { var el = root.querySelector(sel); return el ? el.textContent : ''; }
  function set(root, sel, value) { var el = root.querySelector(sel); if (el) el.textContent = value; }
  function remove(root, sel) { root.querySelectorAll(sel).forEach(function (el) { el.remove(); }); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
