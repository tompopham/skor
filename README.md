# Match scorer

A live match scorer for buzzer quizzes. One person keeps score of two teams while a reader asks the questions. Plain web page, no libraries, no sign-in, no server. It works with no signal once it has been opened once.

**Use it:** https://tompopham.github.io/euqs-scorer/

On an iPhone, open that address in Safari and use Share, then Add to Home Screen. A match is saved on the device you scored it on, and nowhere else. Save a backup file at halftime and at the end (Menu, then Save files).

## What is in this repository

Only the finished web page. Nothing here needs building. Every file in this folder is loaded by the page (`sw.js` keeps a copy of them all for offline use).

## Please do not edit the files here

These files are copied in by a script from the project folder where the scorer is built and tested (the rules of the build, the 250-odd automatic tests and the step-by-step "how to score" guide are there, not here). A change made directly in this repository would be overwritten by the next publish.

## Publishing a change

1. Change the version number in **both** `version.js` and `sw.js`. They must match, and be newer than the published version. This is what tells phones to fetch the new files.
2. Run the project's `publish.sh`. It runs every test, refuses if anything is wrong, and only publishes when told to with `--yes`.

## Who looks after it

Tom Popham (GitHub: tompopham) built it and is the only person who can publish it. **No second person yet.** If you want to take it on, ask him to add you as a collaborator on this repository.
