(function () {
  'use strict';

  // Hook into clipboard copy events from the theme's clipboard.js.
  // When text is copied from a code block, send it to the parent frame
  // (the OpenShift console plugin) for auto-paste into the web terminal.

  document.addEventListener('DOMContentLoaded', function () {
    // The theme's copy buttons have class "copy-button" and use clipboard.js.
    // We listen for clicks on them and grab the text from the adjacent code element.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.copy-button, [data-clipboard-snippet]');
      if (!btn) return;

      var code = btn.nextElementSibling; // clipboard.js target is nextSibling
      if (!code) return;

      var text = code.textContent.trim();
      if (text && window.parent !== window) {
        window.parent.postMessage({ type: 'copy', text: text }, '*');
      }
    });
  });
})();
