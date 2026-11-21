import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellsOf, csvPageBounds, renderCsvPage, sortCsvRows } from '../src/lib/csvPreview'
import {
  buildDbTarget,
  dbCandidatesFromEnv,
  dbEngineOfImage,
  dbResultToCsv,
  formatDbResult,
  missingClients,
  parseDatabaseUrl,
} from '../src/lib/dbViewer'
import { findDbTab, type Tab } from '../src/types/tab'

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

test('同じコンテナの DB タブは今のプロジェクトのものだけを使い回す', () => {
  const tab = (id: string, projectId: string): Tab => ({
    id,
    kind: 'db',
    title: 'db',
    pinned: false,
    container: { id: 'c1', name: 'db', engine: 'mysql' },
    projectId,
  })
  const tabs = [tab('a', 'project-a'), tab('b', 'project-b')]
  assert.equal(findDbTab(tabs, 'c1', 'project-b')?.id, 'b')
  assert.equal(findDbTab(tabs, 'c1', 'project-c'), undefined)
  assert.equal(findDbTab(tabs, 'c2', 'project-a'), undefined)
})

test('クライアントが無いエラーを見分ける', () => {
  assert.deepEqual(missingClients('db-client-not-found:mysql,mariadb'), ['mysql', 'mariadb'])
  assert.equal(missingClients('ERROR 1045'), null)
})
