/**
 * Relax Meridian's agy version gate after a package upgrade.
 *
 * Meridian refuses to start when `agy --version` differs from the version its build
 * validates ("this Meridian build validates agy 1.2.7"). The CLI on this host is
 * 1.3.4, which the previous install accepted because its dist had been edited in
 * place. A `pnpm add -g` gives each version a fresh store directory, so that edit
 * does not survive an upgrade — run this after every install, then restart the unit.
 *
 * Usage: node tmp/meridian/patch-agy-gate.mjs [--dry-run]
 *
 * The rewrite is idempotent: it reads the version the gate currently demands, and
 * replaces it with the installed CLI's version in all three places it appears.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')
const PNPM_HOME = '/root/.local/share/pnpm'
const AGY = process.env.MERIDIAN_AGY_PATH ?? '/root/.local/bin/agy'

const agyVersion = execFileSync(AGY, ['--version'], { encoding: 'utf8' }).trim()
if (!/^\d+\.\d+\.\d+$/.test(agyVersion)) {
  console.error(`unexpected agy version output: ${JSON.stringify(agyVersion)}`)
  process.exit(1)
}

// Every installed Meridian copy, newest first: the global v11 store layout keeps one
// tree per version, and only the active one should be patched.
const roots = []
const globalDir = path.join(PNPM_HOME, 'global', 'v11')
for (const entry of fs.existsSync(globalDir) ? fs.readdirSync(globalDir) : []) {
  const base = path.join(globalDir, entry, 'node_modules')
  for (const candidate of [
    path.join(base, '@rynfar/meridian'),
    ...(fs.existsSync(path.join(base, '.pnpm')) ? fs.readdirSync(path.join(base, '.pnpm')) : [])
      .filter(name => name.startsWith('@rynfar+meridian@'))
      .map(name => path.join(base, '.pnpm', name, 'node_modules/@rynfar/meridian')),
  ]) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) roots.push(candidate)
  }
}

let patched = 0
let already = 0
for (const root of roots) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const dist = path.join(root, 'dist')
  const files = fs.readdirSync(dist).filter(name => name.endsWith('.js'))
  let touched = 0
  for (const name of files) {
    const file = path.join(dist, name)
    const source = fs.readFileSync(file, 'utf8')
    const gate = /this\.cliVersion !== "(\d+\.\d+\.\d+)"/.exec(source)
    if (gate === null) continue
    const demanded = gate[1]
    if (demanded === agyVersion) { already += 1; break }
    const next = source
      .replaceAll(`this.cliVersion !== "${demanded}"`, `this.cliVersion !== "${agyVersion}"`)
      .replaceAll(`validates agy ${demanded}`, `validates agy ${agyVersion}`)
      .replaceAll(`verifiedCliVersion: "${demanded}"`, `verifiedCliVersion: "${agyVersion}"`)
    if (!dryRun) fs.writeFileSync(file, next)
    console.log(`${dryRun ? 'would patch' : 'patched'} ${path.relative(root, file)} in meridian ${version}: gate ${demanded} -> ${agyVersion}`)
    touched += 1
    break
  }
  if (touched > 0) patched += 1
}

console.log(`\nagy ${agyVersion}; ${roots.length} install(s) inspected, ${patched} patched, ${already} already accepting it`)
