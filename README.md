# Bears Depth Cards

Flashcards for learning the Chicago Bears depth chart, jersey numbers and season stats.

Twice a week (Tuesday and Friday mornings) a GitHub Action reads the team's depth chart,
roster and stats pages on chicagobears.com, rebuilds `index.html`, and publishes it with GitHub Pages.

- `template.html` is the app. `build.mjs` fills in the data.
- To update right away: Actions tab, then "Update Bears cards", then "Run workflow".
- If a run fails (for example, the team redesigns its website), the last good version stays online.
