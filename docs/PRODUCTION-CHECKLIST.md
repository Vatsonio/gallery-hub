# Production checklist (gallery-hub)

Реєстр свідомих рішень для проду і статус безпеки. Правило: кожне значення, від якого залежить прод, назване тут, навіть якщо воно типове (типове значення теж рішення). Оновлено 2026-10-01.

Повний аудит (з внутрішніми адресами, тому не в репозиторії): доставлений окремим файлом, docs/AUDIT-2026-09-30.md у локальній копії.

## Залежності: статус CVE

Сканер: `npm audit` (повний граф). Базовий рівень на 2026-09-30: 34 вразливості (3 critical, 12 high, 19 moderate). Після фіксів: 14 (2 critical, 4 high, 8 moderate), усі залишкові лише з мажорним бампом і не досяжні в проді (обґрунтування нижче).

### Закрито

| Пакет / CVE | Де | Критичність | Досяжно в проді | Фікс | Джерело |
|---|---|---|---|---|---|
| next 15.5.18 → 15.5.27 (AVIF RCE, Windows RCE, SSRF, DoS, cache confusion) | рантайм, оптимізатор зображень | Critical | так (оптимізатор відповідав) | бамп до 15.5.24+, стоїть 15.5.27 | GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36, next security release 2026-07 |
| sharp 0.33.5 → 0.35.5 (libvips CVE-2026-33327/33328/35590/35591, libheif) | рантайм, воркер декодує завантаження | High | так (недовірений вхід) | бамп до 0.35.5 (libvips 8.18.x) | GHSA-f88m-g3jw-g9cj |
| otel chain, @grpc/grpc-js, protobufjs, js-yaml, nanoid, tmp, dompurify, fflate, brace-expansion, browserslist, baseline-browser-mapping, posthog-js | транзитивні | High/Moderate | переважно ні (dev/build) | `npm audit fix` без мажорів | npm advisories |
| Витік: пароль власника і share-токен у scripts/inspect_*.py | публічний репозиторій | Critical | так | прибрано дефолти, лише з env | внутрішнє |

### Відкладено з обґрунтуванням (лишились 14, усі мажорні)

| Пакет | Критичність | Чому не чіпаю зараз | Що робити |
|---|---|---|---|
| vitest, vite, vite-node, esbuild, @vitest/coverage-v8, @vitest/mocker | Critical/High (dev) | Лише тест-раннер. Критичне (vitest UI arbitrary read/execute, mocker path traversal, esbuild dev-server) потребує запущеного vitest UI або dev-сервера, чого в проді/CI немає. Мажор vitest 2 → 5 змінює конфіг і тести, валідація потребує повного прогону з Docker (зараз недоступний). | Окремим PR при піднятому стеку: bump vitest@5, виправити конфіг і тести, прогнати весь набір. |
| testcontainers, @testcontainers/postgresql, dockerode, undici, uuid | High/Moderate (dev) | Лише інтеграційні тести. undici тут це залежність testcontainers, а не рантайм застосунку (у рантаймі глобальний fetch Node). Мажор testcontainers 10 → 12. | Разом з vitest-PR: bump testcontainers@12, прогнати інтеграційні тести з Docker. |
| adm-zip | High (dev) | Лише tests/integration/export.flow.test.ts (потребує Docker). У проді ZIP робить archiver, не adm-zip. Валідація потребує Docker. | Bump до 0.6.1 у тому ж тест-PR. |
| next (залишковий moderate), postcss | Moderate/High (build) | Фікс лише у next@16 (мажор). На 15.5.27 усі критичні закриті. postcss це build-time залежність next, не рантайм застосунку. | Див. нижче, міграція 15.x → 16.x. |

### next 15.x life cycle

Лінія Next.js 15.x у Maintenance LTS, кінець підтримки близько 2026-10-21. Після цього патчі безпеки для 15.x не виходитимуть. Рішення: лишаємось на 15.5.27 (усі відомі критичні закриті), міграцію на 16.x запланувати до кінця жовтня 2026 окремим PR з прогоном e2e. Джерело: next security release program, 2026-07.

## Інфраструктура: свідомі значення

Статус кожного пункту детально у повному аудиті. Тут лише рішення, які треба зафіксувати. Пункти, позначені TODO, на момент аудиту не виконані.

### База даних
- Образ Postgres: зараз 16.5. TODO: оновити до 16.15 (десятки CVE між ними, напр. CVE-2026-6473). Мінорне оновлення на тому ж томі.
- `fsync` / `synchronous_commit`: типові (on). Рішення: лишаємо on свідомо (цілісність важливіша за швидкість).
- `shared_buffers` 128MB, `max_connections` 100, `statement_timeout`, `idle_in_transaction_session_timeout`: типові. TODO: задати явно і назвати (запропоновано shared_buffers 256MB, max_connections 60, idle_in_transaction 60s).
- Роль застосунку: зараз суперкористувач. TODO: окрема роль без SUPERUSER.
- Пул postgres.js: max 10, idle_timeout 30, connect_timeout типовий. TODO: connect_timeout 10, statement_timeout у connection.
- pg-boss: типовий пул у app і worker. TODO: у app max 3 supervise:false schedule:false, у worker max 5. Сума зʼєднань до 42 зі 100, вміщається.

### Копії та відновлення
- TODO критично: у Portainer-стеку немає сервісів бекапу взагалі (є лише в docker-compose.prod.yml).
- TODO критично: дампи не виходять за межі хоста (BACKUP_TARGET=local). Потрібна офсайт-копія (B2/R2) з versioning і Object Lock.
- TODO критично: немає скрипта відновлення і жодного тренування відновлення. Потрібні pg-restore.sh і restore-drill.sh з контрольним прогоном, що падає на зіпсованому дампі.

### Контейнери і оновлення
- Теги образів app/worker: `latest`. TODO: закріпити sha, деплой через webhook CI, не Watchtower.
- Watchtower: покинутий проєкт, на Docker 29+ не працює, оновлює app повз міграції. TODO: прибрати.
- Логи контейнерів: без ротації у Portainer-стеку (json-file без max-size). TODO критично: додати ротацію (local driver або max-size 20m max-file 5) плюс log-opts у daemon.json.
- Healthcheck, mem_limit, cpus, read_only, no-new-privileges, cap_drop: є лише частково (postgres/minio/app). TODO: перенести hardening з docker-compose.prod.yml у Portainer-стек.
- Мережа: одна пласка. TODO: розділити edge і backend (postgres/worker у internal).

### Сховище і зображення
- MinIO: образ без оновлень безпеки (community edition більше не публікують образи). app/worker/imgproxy/mirror ходять root-ключами. TODO: окремі користувачі (readwrite для app, readonly для imgproxy/mirror), оновити образ з підтримуваного джерела або планувати заміну.
- imgproxy: підпис URL увімкнено (IMGPROXY_KEY/SALT) — добре. TODO: `IMGPROXY_ALLOWED_SOURCES=s3://gallery/`, прибрати ALLOW_LOOPBACK, `${IMGPROXY_KEY:?}` щоб порожнє значення не вмикало непідписаний режим, задати MAX_SRC_FILE_SIZE і REQUESTS_QUEUE_SIZE, оновити v3→v4 (CONCURRENCY → WORKERS).
- Бакет MinIO: приватний, presigned, без публічної політики — добре.

### Вхід, сесії, застосунок
- Пароль власника: TODO критично, ротувати в env стеку (старий був у публічній історії git, вважати скомпрометованим назавжди).
- seed-admin: TODO, ON CONFLICT DO NOTHING (зараз скидає пароль на кожному деплої), lower(email), прибрати ADMIN_PASSWORD з контейнера app.
- TRUST_PROXY_HEADERS: TODO, передати в контейнер (інакше всі rate-limit зливаються в один глобальний лічильник за IP "unknown").
- Argon2id m=19456 t=2 p=1: відповідає мінімуму OWASP — рішення зафіксоване.
- Кука сесії httpOnly, secure у проді, SameSite=Lax: зафіксоване. TODO дрібне: вирівняти ttl iron-session (14д) з maxAge куки (30д), додати session_version для відкликання.
- CSP має unsafe-inline unsafe-eval у script-src: TODO поступово прибрати unsafe-eval; увімкнути HSTS і Always Use HTTPS у Cloudflare.

### Моніторинг
- TODO: немає зовнішньої перевірки доступності (простій 2026-09 помітив аудит, не алерт). Потрібен Uptime Kuma або healthchecks.io на /api/health, dead-man на бекапи, алерт на диск > 80%.

## Процес

- Сканер у CI: TODO, CI зараз лише typecheck. Додати job з тестами (vitest + testcontainers) і trivy для образів, Dependabot/Renovate.
- Перевірка образів (trivy): не виконано в цій сесії (Docker недоступний). TODO при піднятому Docker.
