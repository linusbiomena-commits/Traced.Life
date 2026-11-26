(() => {
  const isArabic = /^\/ar(?:\/|$)/.test(location.pathname);
  const englishPath = isArabic ? location.pathname.replace(/^\/ar(?=\/|$)/, '') || '/' : location.pathname;
  const arabicPath = '/ar' + (englishPath.startsWith('/') ? englishPath : '/' + englishPath);
  const suffix = location.search + location.hash;
  let preferred;
  try { preferred = localStorage.getItem('linusbiomena-language'); } catch (_) {}
  if (preferred === 'ar' && !isArabic) {
    location.replace(arabicPath + suffix);
    return;
  }
  document.documentElement.lang = isArabic ? 'ar-SA' : 'en';
  document.documentElement.dir = isArabic ? 'rtl' : 'ltr';
  const targetLanguage = isArabic ? 'en' : 'ar';
  const targetPath = isArabic ? englishPath : arabicPath;
  const label = isArabic ? 'English' : 'العربية';
  const header = document.querySelector('header');
  if (!header) return;
  const isClearStrand = /^\/(?:ar\/)?clearstrand-asd(?:\/|$)/.test(location.pathname);
  if (isClearStrand) header.classList.add('clearstrand-language-header');
  // Product contact links live inside dropdowns; use the primary start actions.
  let contacts = isClearStrand
    ? [...header.querySelectorAll('a[href]')].filter(a =>
        /\/start\/?$/.test(new URL(a.href).pathname) && !a.closest('[x-show]'))
    : [...header.querySelectorAll('a[href]')].filter(a => /\/(?:contact|contact-us)\/?$/.test(new URL(a.href).pathname));
  if (!contacts.length) contacts = [...header.querySelectorAll('a[href]')].filter(a => /\/start\/?$/.test(new URL(a.href).pathname));
  const usesNavFallback = !contacts.length;
  if (usesNavFallback) {
    // Prefer a top-level link; the last link overall may sit inside a dropdown.
    contacts = [...header.querySelectorAll('nav')].map(nav =>
      [...nav.querySelectorAll(':scope > ul > li > a[href]')].at(-1) || [...nav.querySelectorAll('a[href]')].at(-1)).filter(Boolean);
  }
  contacts.forEach(contact => {
    const link = contact.cloneNode(true);
    [link, ...link.querySelectorAll('*')].forEach(element => {
      [...element.attributes].forEach(attribute => {
        if (/^(?:x-|@|:)/.test(attribute.name) || attribute.name === 'id') element.removeAttribute(attribute.name);
      });
    });
    link.classList.add('language-switch-link');
    link.href = targetPath + suffix;
    link.removeAttribute('target');
    link.removeAttribute('aria-current');
    link.lang = isArabic ? 'en' : 'ar-SA';
    link.hreflang = link.lang;
    link.setAttribute('aria-label', isArabic ? 'Switch to English' : 'التبديل إلى العربية');
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    let node; let replaced = false;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('svg') || !node.textContent.trim()) continue;
      node.textContent = replaced ? '' : label;
      replaced = true;
    }
    if (!replaced) link.append(label);
    link.addEventListener('click', () => {
      try { localStorage.setItem('linusbiomena-language', targetLanguage); } catch (_) {}
    });
    const navItem = contact.parentElement;
    if (usesNavFallback && navItem.matches('nav > ul > li')) {
      // Give the switch its own item at the end of the main navigation.
      const item = navItem.cloneNode(false);
      item.append(link);
      navItem.parentElement.append(item);
      return;
    }
    contact.parentElement.classList.add('language-switch-row');
    if (isClearStrand) {
      contact.parentElement.classList.add('clearstrand-language-actions');
      if (!contact.classList.contains('btn--primary')) {
        contact.parentElement.classList.add('clearstrand-language-actions--mobile');
      }
    }
    contact.insertAdjacentElement('afterend', link);
  });
  [{ lang: 'en', path: englishPath }, { lang: 'ar-SA', path: arabicPath }].forEach(option => {
    const alternate = document.createElement('link');
    alternate.rel = 'alternate';
    alternate.hreflang = option.lang;
    alternate.href = option.path + suffix;
    document.head.append(alternate);
  });
})();
