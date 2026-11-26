// iPad/iPhone Safari: a menu that only becomes taller than the screen after the device is rotated
// often ignores touch scrolling until it is laid out again. After a rotation or resize, briefly
// re-apply overflow on the open menus so Safari recalculates them and they scroll again.
(function () {
  var SELECTOR = 'header.layout--header, header.clearstrand-language-header [class~="mdm:static"], div.header [id^="dropdown-panel-"]';
  var timer;
  function refresh() {
    var els = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < els.length; i++) {
      var el = els[i], prev = el.style.overflowY;
      el.style.overflowY = 'hidden';
      void el.offsetHeight; // force layout
      el.style.overflowY = prev;
    }
  }
  function later() { clearTimeout(timer); timer = setTimeout(refresh, 300); }
  window.addEventListener('orientationchange', later);
  window.addEventListener('resize', later);
  if (window.screen && screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', later);
})();
