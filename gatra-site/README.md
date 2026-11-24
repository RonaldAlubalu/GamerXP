# Gatra

The site of Gatra Peshtaz, rebuilt from the Squarespace site as plain pages. It lives in this
repository only until it has one of its own.

- `src/pages/` holds the text of each page, `src/layout.html` the header and footer around it.
- `node build.mjs` writes the finished pages to `public/`; `node build.mjs serve` also shows them
  on http://localhost:8090.
- `public/` is the whole site: any web server can serve that folder as it is.

Still to do before it can replace the old site: the forms post to `/api/form`, which does not
exist yet. Until then a visitor who sends a form is told to mail instead.
