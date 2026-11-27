// TRACED restricted-pilot access page. Holds no secret: posts what the tester types to /api/pilot/access.
(function () {
  var form = document.getElementById('pilot-form');
  if (!form) return;
  var input = document.getElementById('pilot-password');
  var toggle = document.getElementById('pilot-toggle');
  var submit = document.getElementById('pilot-submit');
  var error = document.getElementById('pilot-error');
  var lang = document.documentElement.lang.indexOf('ar') === 0 ? 'ar' : 'en';
  var fallback = lang === 'ar' ? '/ar/traced/account/sign-in/' : '/traced/account/sign-in/';
  // Only same-site portal paths are accepted as the destination (no open redirect).
  function safeNext(n) {
    if (!n || n.charAt(0) !== '/' || n.charAt(1) === '/' || n.indexOf('\\') !== -1) return fallback;
    try {
      var u = new URL(n, location.origin);
      if (u.origin !== location.origin || !/^\/(ar\/)?traced\//.test(u.pathname)) return fallback;
      return u.pathname + u.search;
    } catch (e) { return fallback; }
  }
  var next = safeNext(new URLSearchParams(location.search).get('next'));
  // The original #fragment (e.g. #token=… from an invitation, verification or reset email) is kept and
  // handed back to the destination page.
  var hash = location.hash || '';
  var other = document.getElementById('pilot-lang');
  if (other) other.href = other.getAttribute('href').split('?')[0] + location.search + hash;
  function show(msg) { error.textContent = msg; error.hidden = false; }
  toggle.addEventListener('click', function () {
    var visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    toggle.textContent = visible ? form.dataset.show : form.dataset.hide;
    toggle.setAttribute('aria-pressed', String(!visible));
  });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    error.hidden = true;
    if (!input.value) { show(form.dataset.errEmpty); input.focus(); return; }
    var label = submit.textContent;
    submit.disabled = true; submit.textContent = form.dataset.busy;
    fetch('/api/pilot/access', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: input.value }) })
      .then(function (res) {
        if (res.status === 204 || res.status === 404) { location.replace(next + hash); return; }
        input.value = '';
        show(res.status === 401 ? form.dataset.errWrong : res.status === 429 ? form.dataset.errLimit : form.dataset.errOther);
        input.focus();
      })
      .catch(function () { show(form.dataset.errOther); })
      .then(function () { submit.disabled = false; submit.textContent = label; });
  });
})();
