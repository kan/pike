import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellsOf, csvPageBounds, renderCsvPage, sortCsvRows } from '../src/lib/csvPreview'
import {
  buildDbCandidates,
  buildDbTarget,
  connectionKey,
  type DbSavedConnection,
  dbCandidatesFromEnv,
  dbEngineOfImage,
  dbResultToCsv,
  formatDbResult,
  missingClients,
  parseDatabaseUrl,
  parseSavedConnections,
  removeSaved,
  savedToTarget,
  targetToSaved,
  upsertSaved,
} from '../src/lib/dbViewer'
import type { DbTarget } from '../src/types/db'
import { findDbTab, type ShellType, type Tab } from '../src/types/tab'

test('イメージ名から DB の種類を当てる', () => {
  assert.equal(dbEngineOfImage('mysql:8'), 'mysql')
  assert.equal(dbEngineOfImage('docker.io/library/mariadb:11'), 'mysql')
  assert.equal(dbEngineOfImage('postgres:16-alpine'), 'postgres')
  assert.equal(dbEngineOfImage('postgis/postgis:16-3.4'), 'postgres')
  assert.equal(dbEngineOfImage('ghcr.io/me/app:latest'), null)
  // タグや digest の中の語では当てない。
  assert.equal(dbEngineOfImage('redis:mysql-compat'), null)
  assert.equal(dbEngineOfImage('nginx@sha256:postgres'), null)
})

test('結果を表にしても値と NULL がそのまま戻る', () => {
  const data = dbResultToCsv({
    columns: ['id', 'note'],
    rows: [
      ['1', null],
      ['2', 'a\tb\n"c"'],
      ['3', ''],
    ],
    truncated: false,
  })
  assert.deepEqual(data.headers, ['id', 'note'])
  assert.deepEqual(cellsOf(data.rows[0], data.delimiter), ['1', null])
  assert.deepEqual(cellsOf(data.rows[1], data.delimiter), ['2', 'a\tb\n"c"'])
  assert.deepEqual(cellsOf(data.rows[2], data.delimiter), ['3', ''])
  // NULL は空のセルと同じく末尾に並び、描くときは `csv-null` のセルになる。
  const sorted = sortCsvRows(data, { col: 1, dir: 'asc' })
  assert.deepEqual(
    sorted.map((r) => r.num),
    [2, 1, 3],
  )
  const html = renderCsvPage(data, data.rows, csvPageBounds(3, 0, 100), null, null)
  assert.match(html, /<td class="csv-null"><\/td>/)
})

test('接続先は空の欄を指定なしにし、ホストとポートはシェルの経路だけに付ける', () => {
  const form = { engine: 'mysql' as const, host: 'db', port: '99999', user: '', password: 'pw', database: 'app' }
  assert.deepEqual(buildDbTarget(form, { kind: 'container', containerId: 'c1' }), {
    engine: 'mysql',
    via: { kind: 'container', containerId: 'c1' },
    user: undefined,
    password: 'pw',
    database: 'app',
  })
  const shell = buildDbTarget({ ...form, port: '3307' }, { kind: 'shell', shell: { kind: 'cmd' } })
  assert.equal(shell.host, 'db')
  assert.equal(shell.port, 3307)
  assert.equal(buildDbTarget(form, { kind: 'shell', shell: { kind: 'cmd' } }).port, undefined)
})

test('CSV では空文字と NULL を区別し、TSV ではタブを含む値を囲む', () => {
  const result = {
    columns: ['a', 'b'],
    rows: [
      [null, ''],
      ['x,y', 't\tz'],
    ],
    truncated: false,
  }
  assert.equal(formatDbResult(result, 'csv'), 'a,b\n,""\n"x,y",t\tz')
  assert.equal(formatDbResult(result, 'tsv'), 'a\tb\n\t\nx,y\t"t\tz"')
})

test('DATABASE_URL を読む', () => {
  assert.deepEqual(parseDatabaseUrl('postgresql+psycopg2://u:p%40ss@db:5433/app?sslmode=disable'), {
    source: 'DATABASE_URL',
    engine: 'postgres',
    user: 'u',
    password: 'p@ss',
    host: 'db',
    port: 5433,
    database: 'app',
  })
  assert.equal(parseDatabaseUrl('mysql://root@localhost/app')?.port, null)
  // 角括弧の IPv6 は 1 つのホストとして読み、角括弧を外す。
  const v6 = parseDatabaseUrl('postgresql://u:pw@[::1]:5432/app')
  assert.deepEqual([v6?.host, v6?.port, v6?.database, v6?.password], ['::1', 5432, 'app', 'pw'])
  assert.equal(parseDatabaseUrl('mysql://[fe80::1%25eth0]/db')?.host, 'fe80::1%25eth0')
  assert.equal(parseDatabaseUrl('redis://localhost:6379'), null)
  assert.equal(parseDatabaseUrl('not a url'), null)
})

test('.env から候補を拾う', () => {
  const env = [
    '# comment',
    'export DATABASE_URL="mysql://app:pw@127.0.0.1:3306/app"',
    'TEST_DATABASE_URL=postgres://t@localhost/test # inline',
    'DB_CONNECTION=pgsql',
    'DB_HOST=127.0.0.1',
    'DB_PORT=5432',
    'DB_DATABASE=laravel',
    "DB_USERNAME='sail'",
    'DB_PASSWORD="se#cret" # local',
  ].join('\n')
  const got = dbCandidatesFromEnv(env)
  assert.deepEqual(
    got.map((c) => [c.source, c.engine, c.host, c.port, c.user, c.database]),
    [
      ['DATABASE_URL', 'mysql', '127.0.0.1', 3306, 'app', 'app'],
      ['TEST_DATABASE_URL', 'postgres', 'localhost', null, 't', 'test'],
      ['DB_CONNECTION', 'postgres', '127.0.0.1', 5432, 'sail', 'laravel'],
    ],
  )
  // 引用符で囲んだ値は、中の `#` を残して後ろのコメントだけ捨てる。
  assert.equal(got[2].password, 'se#cret')
})

test('同じ接続先の DB タブは今のプロジェクトのものだけを使い回す', () => {
  const target: DbTarget = { engine: 'mysql', via: { kind: 'container', containerId: 'c1' } }
  const key = connectionKey(target)
  const tab = (id: string, projectId: string): Tab => ({
    id,
    kind: 'db',
    title: 'db',
    pinned: false,
    target,
    key,
    projectId,
  })
  const tabs = [tab('a', 'project-a'), tab('b', 'project-b')]
  assert.equal(findDbTab(tabs, key, 'project-b')?.id, 'b')
  assert.equal(findDbTab(tabs, key, 'project-c'), undefined)
  assert.equal(findDbTab(tabs, 'container:c2', 'project-a'), undefined)
})

const wsl: ShellType = { kind: 'wsl', distro: 'Ubuntu' }

test('接続先の同一性はパスワードを含めず、空の欄と未指定を同じに扱う', () => {
  const a: DbTarget = {
    engine: 'mysql',
    via: { kind: 'shell', shell: wsl },
    host: '127.0.0.1',
    port: 3306,
    user: 'app',
  }
  const b: DbTarget = { ...a, password: 'pw', database: '' }
  assert.equal(connectionKey(a), connectionKey(b))
  assert.notEqual(connectionKey(a), connectionKey({ ...a, port: 3307 }))
  assert.notEqual(connectionKey(a), connectionKey({ ...a, via: { kind: 'shell', shell: { kind: 'cmd' } } }))
  assert.equal(connectionKey({ engine: 'postgres', via: { kind: 'container', containerId: 'x' } }), 'container:x')
})

test('候補はコンテナ・保存した接続・.env の順で、.env と同じ保存した接続には .env のパスワードを持たせる', () => {
  const saved: DbSavedConnection = {
    engine: 'mysql',
    shell: wsl,
    host: '127.0.0.1',
    port: 33306,
    user: 'app',
    database: 'app',
  }
  const env = dbCandidatesFromEnv(
    ['DATABASE_URL=mysql://app:apppw@127.0.0.1:33306/app', 'TEST_DATABASE_URL=postgres://p@localhost/t'].join('\n'),
  )
  const list = buildDbCandidates({
    containers: [{ id: 'c1', name: 'mysql', image: 'mysql:8', engine: 'mysql' }],
    saved: [saved],
    env,
    shell: wsl,
  })
  assert.deepEqual(
    list.map((c) => [c.kind, c.label]),
    [
      ['container', 'mysql'],
      ['saved', 'app@127.0.0.1:33306/app'],
      ['env', 'p@localhost:5432/t'],
    ],
  )
  // .env と重なった保存した接続は 1 行にまとめ、押せばそのまま .env のパスワードでつなぐ。
  assert.equal(list[1].target.password, 'apppw')
  assert.equal(targetToSaved(list[1].target)?.port, 33306)
  // 保存する形にパスワードは入らない。
  assert.equal(JSON.stringify(targetToSaved(list[1].target)).includes('apppw'), false)
  assert.equal(targetToSaved(list[0].target), null)
})

test('保存した接続は同じものを 1 つにまとめて先頭へ寄せ、壊れた値は落とす', () => {
  const s = (port: number): DbSavedConnection => ({
    engine: 'postgres',
    shell: wsl,
    host: 'h',
    port,
    user: 'u',
    database: 'd',
  })
  let list = upsertSaved([], s(1))
  list = upsertSaved(list, s(2))
  list = upsertSaved(list, s(1))
  assert.deepEqual(
    list.map((x) => x.port),
    [1, 2],
  )
  assert.deepEqual(
    removeSaved(list, connectionKey(savedToTarget(s(2)))).map((x) => x.port),
    [1],
  )
  assert.deepEqual(parseSavedConnections([s(3), { engine: 'oracle', shell: wsl }, 'x', null]), [s(3)])
  // distro の無い WSL のような、シェルとして成り立たないものも落とす。
  assert.deepEqual(
    parseSavedConnections([
      { ...s(4), shell: { kind: 'wsl' } },
      { ...s(5), shell: { kind: 'zsh' } },
    ]),
    [],
  )
  assert.deepEqual(parseSavedConnections({}), [])
})

test('クライアントが無いエラーを見分ける', () => {
  assert.deepEqual(missingClients('db-client-not-found:mysql,mariadb'), ['mysql', 'mariadb'])
  assert.equal(missingClients('ERROR 1045'), null)
})
