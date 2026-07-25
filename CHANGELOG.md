# Changelog

## [0.6.0](https://github.com/IbbyLabs/watchmuse/compare/v0.5.1...v0.6.0) (2026-07-25)


### Features

* **catalogs:** add a why-recommended line to meta descriptions ([31ab93a](https://github.com/IbbyLabs/watchmuse/commit/31ab93a5b0bd9d9752ad8bad9efa1dd4ce6505f4))
* **catalogs:** add rewatch and new-season selection ([5a7f250](https://github.com/IbbyLabs/watchmuse/commit/5a7f250df91f0ad02d9deae07ad77bd2f79a4f6d))
* **catalogs:** add setup export and import ([8c7d88f](https://github.com/IbbyLabs/watchmuse/commit/8c7d88f8fd61ff5996835d45bf87082c4f98d358))
* **catalogs:** explain why a filtered catalog is short ([1f86967](https://github.com/IbbyLabs/watchmuse/commit/1f869675b145e9a2868080b5fb16d073250321c9))
* **catalogs:** honour the per-catalog source binding ([e4a0384](https://github.com/IbbyLabs/watchmuse/commit/e4a038412614be76527797f131cad2fbee433645))
* **catalogs:** mirror dismissals to Trakt hidden recommendations ([e28bc4d](https://github.com/IbbyLabs/watchmuse/commit/e28bc4d7dd4733d193bedd0b40543414b2162a9b))
* **catalogs:** reshuffle filter rows once a day ([20e0e69](https://github.com/IbbyLabs/watchmuse/commit/20e0e6902d74fab51ae3f158a50984551eac46b9))
* **catalogs:** serve the rewatch and new-season catalog types ([0fe6632](https://github.com/IbbyLabs/watchmuse/commit/0fe6632033f4f73aedd8b47eed059a8251406a38))
* **providers:** add Letterboxd as a history source ([3288dc4](https://github.com/IbbyLabs/watchmuse/commit/3288dc4e0c92998bbf03b98d0055218c007f5b70))
* **providers:** read ratings from Trakt and Simkl ([80280c6](https://github.com/IbbyLabs/watchmuse/commit/80280c68f1e0ff3cfc35b2ab950f1ea9d35b010e))
* **providers:** read the Stremio library as a history source ([c9e186d](https://github.com/IbbyLabs/watchmuse/commit/c9e186d1b3b62db10ada365636fa5d339a656c13))
* **reco:** calibrate recommendations to the user's era and spread out each row ([fdf2e5b](https://github.com/IbbyLabs/watchmuse/commit/fdf2e5b24a8b0397fd822950b74fd02d9b836452))
* **reco:** track which seasons of a show were watched ([7144d58](https://github.com/IbbyLabs/watchmuse/commit/7144d58f59317373d141f3d6672b5c2fa3965824))
* **scheduler:** refresh stale catalogs and Trakt tokens in the background ([c25ac02](https://github.com/IbbyLabs/watchmuse/commit/c25ac027bf71bee1ad34330eb40f21b1f2a0dbf7))
* **search:** add a search catalog ranked by taste ([3654cbf](https://github.com/IbbyLabs/watchmuse/commit/3654cbf8e87f9f562721780d271cc28fec17f105))
* **server:** add Prometheus metrics and an Unraid template ([efb74ff](https://github.com/IbbyLabs/watchmuse/commit/efb74ff88049fa0383673709cc29636065474d0d))
* **watch:** filter catalogs by where a title actually streams ([8f48e7f](https://github.com/IbbyLabs/watchmuse/commit/8f48e7ff343c82a68eb886f1193c45a39d621ac0))
* **web:** add the TMDB logo their attribution terms ask for ([0400178](https://github.com/IbbyLabs/watchmuse/commit/0400178a89b01fe7e7df044267459d1267a63a3d))
* **web:** pick a streaming country and filter catalogs by service ([536c08c](https://github.com/IbbyLabs/watchmuse/commit/536c08c83db46cc9cfae78e309718715326de709))
* **web:** show the attribution TMDB's terms require ([2d397eb](https://github.com/IbbyLabs/watchmuse/commit/2d397ebee1c942c1284ac7b78e56adc8bb4a2eb3))


### Bug Fixes

* **ai:** stop the BYO-key endpoint being used to probe the network ([6be03be](https://github.com/IbbyLabs/watchmuse/commit/6be03be5f6b2b515d7e77ea27ca02291aca5cfbb))
* **connections:** keep OAuth state and Trakt tokens alive across restarts ([f3034df](https://github.com/IbbyLabs/watchmuse/commit/f3034dfa35495cdb3495149c8ef49d094e42500a))
* **pool:** stop a failed history pull from blanking every catalog ([eb3f2f4](https://github.com/IbbyLabs/watchmuse/commit/eb3f2f4218a33bc46d5766534fa9d818f4703076))
* **providers:** pace Trakt and Simkl against the shared app credential ([5d147f8](https://github.com/IbbyLabs/watchmuse/commit/5d147f8b90565cbc36394588275bcb71908348ef))
* **reco:** stop recommendations skewing to old, thinly-rated titles ([3e194be](https://github.com/IbbyLabs/watchmuse/commit/3e194be3f1aefafe90c085dfa8db607bd64e4929))
* **tmdb:** keep the concurrency bound process-wide, not per client ([f844717](https://github.com/IbbyLabs/watchmuse/commit/f844717e978dea2019cb2744517f363e503c97af))
* **web:** correct the artwork fallback description ([a972e9f](https://github.com/IbbyLabs/watchmuse/commit/a972e9f983f1ecfcba277ce61dbe0b2b21ad67c3))


### Performance Improvements

* **http:** allow bounded concurrency instead of one request at a time ([e2e8d6e](https://github.com/IbbyLabs/watchmuse/commit/e2e8d6e568f70b8f20282a267c0a71aa170fabf6))

## [0.5.1](https://github.com/IbbyLabs/watchmuse/compare/v0.5.0...v0.5.1) (2026-07-12)


### Bug Fixes

* **docker:** bake APP_VERSION after the app COPY so it isn't cached stale ([befd880](https://github.com/IbbyLabs/watchmuse/commit/befd880878215d2e69ef1b01b2216933cd9cdcbd))

## [0.5.0](https://github.com/IbbyLabs/watchmuse/compare/v0.4.1...v0.5.0) (2026-07-12)


### Features

* **providers:** add MDBList as a history source ([e43b1a5](https://github.com/IbbyLabs/watchmuse/commit/e43b1a55b6b487e4e896c13728185f9d01292914))

## [0.4.1](https://github.com/IbbyLabs/watchmuse/compare/v0.4.0...v0.4.1) (2026-07-11)


### Bug Fixes

* show catalog synopsis in Stremio metas ([22546bc](https://github.com/IbbyLabs/watchmuse/commit/22546bcc109ab795f38a2df1266653701677405d))
* stop seeding only the oldest titles when watches lack dates ([e80716d](https://github.com/IbbyLabs/watchmuse/commit/e80716d4dbda43dc78bb45ce4404f6efc470862d))
