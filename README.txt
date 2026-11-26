Traced website

Static English / Arabic site, split out of "LinusBio MENA Website" on 2026-11-26.
Everything that is served lives in dist.

  English: /traced/
  Arabic:  /ar/traced/
  /  and  /ar/  redirect to the pages above.

Pages keep their original paths (/traced/...) so every link and image
works unchanged. Shared files (media, assets, language-switch.*, etc.) are
copies of the ones in LinusBio MENA Website.

Preview with Python 3:
  python -m http.server 8000 --directory dist
then open http://localhost:8000/
