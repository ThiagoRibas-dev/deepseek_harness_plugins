/**
 * Build names-data.json from raw text files in /export/DownloadsSSD/Projects/Writing/TTRPG/D&D35/rules/dm_aids/names/
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC_DIR = '/export/DownloadsSSD/Projects/Writing/TTRPG/D&D35/rules/dm_aids/names'
const OUT_FILE = join(import.meta.dirname, '../names-data.json')

function readLines(filename) {
  return readFileSync(join(SRC_DIR, filename), 'utf8').split('\n')
}

function cleanToken(token) {
  if (!token) return ''
  let t = token.trim()
  t = t.replace(/^[0-9]+(-[0-9]+)?\s*/, '')
  t = t.replace(/^["'\[]+/, '').replace(/["'\]]+$/, '')
  return t.trim()
}

function splitCell(cell) {
  if (!cell) return []
  const trimmed = cell.trim()
  if (!trimmed) return []

  const parts = trimmed.split(/[,/]/)
  const result = []
  for (const part of parts) {
    const cleaned = cleanToken(part)
    if (
      cleaned &&
      !/^[0-9]+(-[0-9]+)?$/.test(cleaned) &&
      !/^\d+$/.test(cleaned) &&
      !/die roller/i.test(cleaned) &&
      !/^roll\s+/i.test(cleaned) &&
      cleaned !== 'Roll twice' &&
      cleaned !== 'Roll 1d'
    ) {
      result.push(cleaned)
    }
  }
  return result
}

function parseDwarven() {
  const lines = readLines('Dwarven Names.txt')
  const canonFirst = []
  const syllabicStart = []
  const syllabicEnd = []
  const byNames = []
  const clanNames = []
  const clanStart = []
  const clanEnd = []

  let section = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.includes('The (Complete?) Corpus of Dwarven Use-Names')) { section = 'canon_first'; continue }
    if (trimmed.includes('Dwarven First Names – Tolkienesque')) { section = 'syllabic_first'; continue }
    if (trimmed.includes('The (Complete?) Corpus of Dwarven By-Names')) { section = 'by_names'; continue }
    if (trimmed.includes('The (Complete?) Corpus of Dwarven Clan Names')) { section = 'clan_names'; continue }
    if (trimmed.includes('Dwarven Clan Names – Tolkienesque')) { section = 'clan_compounds'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('You can') || trimmed.startsWith('This table') || trimmed.includes('Start of name') || trimmed.includes('Tolkienesque')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    if (cols.length === 0) continue

    if (section === 'canon_first') {
      for (const col of cols) {
        if (/^[0-9]/.test(col)) continue
        for (const token of splitCell(col)) {
          if (token && !canonFirst.includes(token)) canonFirst.push(token)
        }
      }
    } else if (section === 'syllabic_first') {
      const textCols = cols.filter(c => !/^[0-9]/.test(c))
      if (textCols.length >= 2) {
        splitCell(textCols[0]).forEach(t => { if (!syllabicStart.includes(t)) syllabicStart.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!syllabicEnd.includes(t)) syllabicEnd.push(t) })
      } else if (textCols.length === 1) {
        splitCell(textCols[0]).forEach(t => { if (!syllabicEnd.includes(t)) syllabicEnd.push(t) })
      }
    } else if (section === 'by_names') {
      const textCols = cols.filter(c => !/^[0-9]/.test(c))
      for (const col of textCols) {
        if (col && !byNames.includes(col)) byNames.push(col)
      }
    } else if (section === 'clan_names') {
      const textCols = cols.filter(c => !/^[0-9]/.test(c))
      for (const col of textCols) {
        for (const token of splitCell(col)) {
          if (token && !clanNames.includes(token)) clanNames.push(token)
        }
      }
    } else if (section === 'clan_compounds') {
      const textCols = cols.filter(c => !/^[0-9]/.test(c))
      if (textCols.length >= 2) {
        splitCell(textCols[0]).forEach(t => { if (!clanStart.includes(t)) clanStart.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!clanEnd.includes(t)) clanEnd.push(t) })
      }
    }
  }

  return {
    canon_first: canonFirst,
    syllabic: { start: syllabicStart, end: syllabicEnd },
    by_names: byNames,
    clan_names: clanNames,
    clan_compounds: { start: clanStart, end: clanEnd },
  }
}

function parseElvish() {
  const lines = readLines('Elvish Names.txt')
  const prefixes = []
  const centers = []
  const suffixes = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('Elvish') || trimmed.startsWith('This is') || trimmed.startsWith('Roll') || trimmed.startsWith('You can') || trimmed.includes('Prefix')) continue
    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))
    if (textCols.length >= 3) {
      splitCell(textCols[0]).forEach(t => { if (!prefixes.includes(t)) prefixes.push(t) })
      splitCell(textCols[1]).forEach(t => { if (!centers.includes(t)) centers.push(t) })
      splitCell(textCols[2]).forEach(t => { if (!suffixes.includes(t)) suffixes.push(t) })
    }
  }

  return { prefixes, centers, suffixes }
}

function parseHalfling() {
  const lines = readLines('Halfling Names.txt')
  const female = []
  const male = []
  const surnames = []
  const surnameStart = []
  const surnameEnd = []

  let section = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.includes('Female Hobbit First Names')) { section = 'female'; continue }
    if (trimmed.includes('Male Hobbit First Names')) { section = 'male'; continue }
    if (trimmed.includes('Hobbit Surnames Actually Used')) { section = 'surnames'; continue }
    if (trimmed.includes('Halfling Surnames – Tolkienesque')) { section = 'compounds'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('You can') || trimmed.startsWith('Again') || trimmed.startsWith('Some of') || trimmed.startsWith('Once again') || trimmed.startsWith('I tried') || trimmed.includes('Start of name')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))

    if (section === 'female') {
      for (const col of textCols) {
        for (const token of splitCell(col)) {
          if (token && !female.includes(token)) female.push(token)
        }
      }
    } else if (section === 'male') {
      for (const col of textCols) {
        for (const token of splitCell(col)) {
          if (token && !male.includes(token)) male.push(token)
        }
      }
    } else if (section === 'surnames') {
      for (const col of textCols) {
        for (const token of splitCell(col)) {
          if (token && !surnames.includes(token)) surnames.push(token)
        }
      }
    } else if (section === 'compounds') {
      if (textCols.length >= 2) {
        splitCell(textCols[0]).forEach(t => { if (!surnameStart.includes(t)) surnameStart.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!surnameEnd.includes(t)) surnameEnd.push(t) })
      }
    }
  }

  return {
    female,
    male,
    surnames,
    surname_compounds: { start: surnameStart, end: surnameEnd },
  }
}

function parseHumanFantasy() {
  const lines = readLines('Human Names with a Fantasy Flavor.txt')
  const firstNames = []
  const surnameForms = []
  const elements = {
    nature: { element: [], environment: [], forest: [] },
    poetry: { destiny: [], emotion: [], cycle: [] },
    mundane: { weapon: [], place: [], farm: [] },
    creature: { monster: [], person: [], animal: [] },
    morality: { sinister: [], holy: [], color: [] },
    actor1: { hurter: [], doer: [], feeler: [] },
    actor2: { mover: [], relater: [], exister: [] },
  }

  let section = ''
  let currentSubCat = '' // 'sub1' (1-2), 'sub2' (3-4), 'sub3' (5-6)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.includes('First Names – Generic Fantasy')) { section = 'first'; continue }
    if (trimmed.includes('Surname Forms – Generic Fantasy')) { section = 'forms'; continue }
    if (trimmed.includes('Surname Elements – Generic Fantasy')) { section = 'elements'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('Then refer') || trimmed.startsWith('If you have') || trimmed.startsWith('Feel free') || trimmed.startsWith('If you’re') || trimmed.startsWith('You can choose')) continue

    if (section === 'first') {
      const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
      const textCols = cols.filter(c => !/^[0-9]/.test(c))
      for (const col of textCols) {
        for (const token of splitCell(col)) {
          if (token && !firstNames.includes(token)) firstNames.push(token)
        }
      }
    } else if (section === 'forms') {
      const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
      const textCols = cols.filter(c => !/^[0-9]/.test(c))
      for (const col of textCols) {
        if (col && !surnameForms.includes(col)) surnameForms.push(col)
      }
    } else if (section === 'elements') {
      if (line.includes('Element') && line.includes('Destiny')) {
        currentSubCat = 'sub1'
        continue
      } else if (line.includes('Environment') && line.includes('Emotion')) {
        currentSubCat = 'sub2'
        continue
      } else if (line.includes('Forest') && line.includes('Cycle')) {
        currentSubCat = 'sub3'
        continue
      }
      if (line.includes('NATURE') || line.includes('POETRY')) continue

      const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
      const textCols = cols.filter(c => !/^[0-9]/.test(c))
      if (textCols.length >= 7) {
        const catMap = {
          sub1: ['nature.element', 'poetry.destiny', 'mundane.weapon', 'creature.monster', 'morality.sinister', 'actor1.hurter', 'actor2.mover'],
          sub2: ['nature.environment', 'poetry.emotion', 'mundane.place', 'creature.person', 'morality.holy', 'actor1.doer', 'actor2.relater'],
          sub3: ['nature.forest', 'poetry.cycle', 'mundane.farm', 'creature.animal', 'morality.color', 'actor1.feeler', 'actor2.exister'],
        }[currentSubCat]

        if (catMap) {
          for (let colIdx = 0; colIdx < 7; colIdx++) {
            const path = catMap[colIdx].split('.')
            const targetList = elements[path[0]][path[1]]
            splitCell(textCols[colIdx]).forEach(t => {
              if (t && !targetList.includes(t)) targetList.push(t)
            })
          }
        }
      }
    }
  }

  return { first_names: firstNames, surname_forms: surnameForms, elements }
}

function parseHumanHistorical() {
  const lines = readLines('Human Names with a Historical Flavor.txt')
  const oldEnglish = { starts: [], ends: [] }
  const medievalEnglish = { female: [], male: [] }
  const celtic = { female: [], male: [] }
  const nordic = { female: [], male: [] }
  const sanskrit = { female: [], male: [] }
  const tradeSurnames = []
  const localitySurnames = []

  let section = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.includes('First Names – Old English-esque')) { section = 'old_english'; continue }
    if (trimmed.includes('First Names – Medieval English and Celtic-esque')) { section = 'medieval_celtic'; continue }
    if (trimmed.includes('First Names – Nordic-esque')) { section = 'nordic'; continue }
    if (trimmed.includes('First Names – Sanskrit-esque')) { section = 'sanskrit'; continue }
    if (trimmed.includes('Medieval English Surnames – Trade-related')) { section = 'trade'; continue }
    if (trimmed.includes('Medieval Surnames – Locality-related')) { section = 'locality'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('You can') || trimmed.includes('Female') || trimmed.includes('13th Century')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))

    if (section === 'old_english') {
      for (const col of textCols) {
        splitCell(col).forEach(t => {
          const subTokens = t.split(/\s+/).map(cleanToken).filter(Boolean)
          subTokens.forEach(st => {
            if (st && !oldEnglish.starts.includes(st)) oldEnglish.starts.push(st)
          })
        })
      }
    } else if (section === 'medieval_celtic') {
      // 4 text columns: 13th C Eng Fem, 13th C Eng Male, Celtic Fem, Celtic Male
      if (textCols.length >= 4) {
        splitCell(textCols[0]).forEach(t => { if (!medievalEnglish.female.includes(t)) medievalEnglish.female.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!medievalEnglish.male.includes(t)) medievalEnglish.male.push(t) })
        splitCell(textCols[2]).forEach(t => { if (!celtic.female.includes(t)) celtic.female.push(t) })
        splitCell(textCols[3]).forEach(t => { if (!celtic.male.includes(t)) celtic.male.push(t) })
      }
    } else if (section === 'nordic') {
      // Columns: Female Names (2 cols), Male Names (multiple cols)
      // Line format: [dice] [dice] Female1 Female2 Male1 Male2 Male3...
      if (textCols.length >= 3) {
        splitCell(textCols[0]).forEach(t => { if (!nordic.female.includes(t)) nordic.female.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!nordic.female.includes(t)) nordic.female.push(t) })
        for (let j = 2; j < textCols.length; j++) {
          splitCell(textCols[j]).forEach(t => { if (!nordic.male.includes(t)) nordic.male.push(t) })
        }
      }
    } else if (section === 'sanskrit') {
      // Columns: Female (2 cols), Male (2 cols)
      if (textCols.length >= 4) {
        splitCell(textCols[0]).forEach(t => { if (!sanskrit.female.includes(t)) sanskrit.female.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!sanskrit.female.includes(t)) sanskrit.female.push(t) })
        splitCell(textCols[2]).forEach(t => { if (!sanskrit.male.includes(t)) sanskrit.male.push(t) })
        splitCell(textCols[3]).forEach(t => { if (!sanskrit.male.includes(t)) sanskrit.male.push(t) })
      } else if (textCols.length === 2) {
        splitCell(textCols[0]).forEach(t => { if (!sanskrit.female.includes(t)) sanskrit.female.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!sanskrit.male.includes(t)) sanskrit.male.push(t) })
      }
    } else if (section === 'trade') {
      for (const col of textCols) {
        splitCell(col).forEach(t => { if (!tradeSurnames.includes(t)) tradeSurnames.push(t) })
      }
    } else if (section === 'locality') {
      for (const col of textCols) {
        splitCell(col).forEach(t => { if (!localitySurnames.includes(t)) localitySurnames.push(t) })
      }
    }
  }

  // Old English starts can double as ends in Anglo-Saxon dithematic compounding
  oldEnglish.ends = [...oldEnglish.starts]

  return {
    old_english: oldEnglish,
    medieval_english: medievalEnglish,
    celtic,
    nordic,
    sanskrit,
    surnames_trade: tradeSurnames,
    surnames_locality: localitySurnames,
  }
}

function parseAuthors() {
  const lines = readLines('Human Names in the Styles of Fantasy Authors.txt')
  const tolkien = { female: [], male: [] }
  const leGuin = []
  const donaldson = []
  const howard = {
    keshan: [],
    turan: [],
    zingara: [],
    shem: [],
    nordheim: [],
    cimmerian: { female: [], male: [] },
    aquilonian: { female: [], male: [] },
    stygian: { female: [], male: [] },
  }
  const martin = { female: [], male: [] }

  let section = ''
  let subSection = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.includes('First Names – J.R.R. Tolkienesque')) { section = 'tolkien'; continue }
    if (trimmed.includes('First Names – Ursula Le Guinesque')) { section = 'le_guin'; continue }
    if (trimmed.includes('First Names – Stephen Donaldsonesque')) { section = 'donaldson'; continue }
    if (trimmed.includes('First Names – Robert E. Howardesque') && !trimmed.includes('Continued')) { section = 'howard1'; continue }
    if (trimmed.includes('First Names – Robert E. Howardesque (Continued)')) { section = 'howard2'; continue }
    if (trimmed.includes('First Names – George R.R. Martinesque')) { section = 'martin'; continue }

    if (section === 'martin') {
      if (trimmed.startsWith('Female') || trimmed.includes('Female Names')) { subSection = 'fem'; continue }
      if (trimmed.startsWith('Male') || trimmed.includes('Male Names')) { subSection = 'male'; continue }
    }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('These are') || trimmed.startsWith('Female Names') || trimmed.startsWith('Male Names')) continue
    if (trimmed.includes('Female Names \tMale Names')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))

    if (section === 'tolkien') {
      // 4 text columns: Female1, Female2, Male1, Male2
      if (textCols.length >= 4) {
        splitCell(textCols[0]).forEach(t => { if (!tolkien.female.includes(t)) tolkien.female.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!tolkien.female.includes(t)) tolkien.female.push(t) })
        splitCell(textCols[2]).forEach(t => { if (!tolkien.male.includes(t)) tolkien.male.push(t) })
        splitCell(textCols[3]).forEach(t => { if (!tolkien.male.includes(t)) tolkien.male.push(t) })
      }
    } else if (section === 'le_guin') {
      for (const col of textCols) {
        splitCell(col).forEach(t => { if (!leGuin.includes(t)) leGuin.push(t) })
      }
    } else if (section === 'donaldson') {
      for (const col of textCols) {
        splitCell(col).forEach(t => { if (!donaldson.includes(t)) donaldson.push(t) })
      }
    } else if (section === 'howard1') {
      // Col 0: Keshan, Col 1-2: Turan, Col 3-4: Zingara, Col 5: Shem, Col 6: Nordheim
      if (textCols.length >= 5) {
        splitCell(textCols[0]).forEach(t => { if (!howard.keshan.includes(t)) howard.keshan.push(t) })
        if (textCols.length >= 7) {
          splitCell(textCols[1]).forEach(t => { if (!howard.turan.includes(t)) howard.turan.push(t) })
          splitCell(textCols[2]).forEach(t => { if (!howard.turan.includes(t)) howard.turan.push(t) })
          splitCell(textCols[3]).forEach(t => { if (!howard.zingara.includes(t)) howard.zingara.push(t) })
          splitCell(textCols[4]).forEach(t => { if (!howard.zingara.includes(t)) howard.zingara.push(t) })
          splitCell(textCols[5]).forEach(t => { if (!howard.shem.includes(t)) howard.shem.push(t) })
          splitCell(textCols[6]).forEach(t => { if (!howard.nordheim.includes(t)) howard.nordheim.push(t) })
        } else {
          for (const c of textCols) splitCell(c).forEach(t => { if (!howard.turan.includes(t)) howard.turan.push(t) })
        }
      }
    } else if (section === 'howard2') {
      if (trimmed.startsWith('Female') || trimmed.includes('Female')) continue
      // 6 text columns: Cimmerian (Fem, Male), Aquilonian (Fem, Male), Stygian (Fem, Male)
      if (textCols.length >= 6) {
        // Tokens in each cell are space-separated lists of names!
        const getWords = str => str.split(/\s+/).map(cleanToken).filter(Boolean)
        getWords(textCols[0]).forEach(t => { if (!howard.cimmerian.female.includes(t)) howard.cimmerian.female.push(t) })
        getWords(textCols[1]).forEach(t => { if (!howard.cimmerian.male.includes(t)) howard.cimmerian.male.push(t) })
        getWords(textCols[2]).forEach(t => { if (!howard.aquilonian.female.includes(t)) howard.aquilonian.female.push(t) })
        getWords(textCols[3]).forEach(t => { if (!howard.aquilonian.male.includes(t)) howard.aquilonian.male.push(t) })
        getWords(textCols[4]).forEach(t => { if (!howard.stygian.female.includes(t)) howard.stygian.female.push(t) })
        getWords(textCols[5]).forEach(t => { if (!howard.stygian.male.includes(t)) howard.stygian.male.push(t) })
      }
    } else if (section === 'martin') {
      if (trimmed.startsWith('Female') || trimmed.includes('Female Names')) { subSection = 'fem'; continue }
      if (trimmed.startsWith('Male') || trimmed.includes('Male Names')) { subSection = 'male'; continue }
      for (const col of textCols) {
        splitCell(col).forEach(t => {
          if (subSection === 'fem') {
            if (!martin.female.includes(t)) martin.female.push(t)
          } else {
            if (!martin.male.includes(t)) martin.male.push(t)
          }
        })
      }
    }
  }

  return { tolkien, le_guin: leGuin, donaldson, howard, martin }
}

function parseTownsEnglish() {
  const lines = readLines('Medieval English-Style Town Names.txt')
  const result = {
    general: { prefixes: [], suffixes: [] },
    coast: { prefixes: [], suffixes: [] },
    forest: { prefixes: [], suffixes: [] },
    hill: { prefixes: [], suffixes: [] },
    lake: { prefixes: [], suffixes: [] },
    mountain: { prefixes: [], suffixes: [] },
    river: { prefixes: [], suffixes: [] },
    swamp: { prefixes: [], suffixes: [] },
  }

  let terrain = 'general'
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.includes('English-Style Town Names – General')) { terrain = 'general'; continue }
    if (trimmed.includes('Coast-Related')) { terrain = 'coast'; continue }
    if (trimmed.includes('Forest-Related')) { terrain = 'forest'; continue }
    if (trimmed.includes('Hill-Related')) { terrain = 'hill'; continue }
    if (trimmed.includes('Lake-Related')) { terrain = 'lake'; continue }
    if (trimmed.includes('Mountain-Related')) { terrain = 'mountain'; continue }
    if (trimmed.includes('River-Related')) { terrain = 'river'; continue }
    if (trimmed.includes('Swamp-Related')) { terrain = 'swamp'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('Prefix') || trimmed.includes('How to do it')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))
    if (textCols.length >= 2) {
      splitCell(textCols[0]).forEach(t => { if (!result[terrain].prefixes.includes(t)) result[terrain].prefixes.push(t) })
      splitCell(textCols[1]).forEach(t => { if (!result[terrain].suffixes.includes(t)) result[terrain].suffixes.push(t) })
    }
  }

  return result
}

function parseProperLocations() {
  const lines = readLines('Proper Names for Fantasy Locations.txt')
  const realms = {
    generic: { prefixes: [], centers: [], suffixes: [] },
    good: { prefixes: [], centers: [], suffixes: [] },
    evil: { prefixes: [], centers: [], suffixes: [] },
    magical: { prefixes: [], centers: [], suffixes: [] },
  }
  const ancestral = {
    dwarf: { prefixes: [], centers: [], suffixes: [] },
    elf: { prefixes: [], centers: [], suffixes: [] },
    halfling: { prefixes: [], suffixes: [] },
    orc: { prefixes: [], suffixes: [] },
  }

  let section = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.includes('Generic Fantasy Realms – Prefixes')) { section = 'realms_generic_pre'; continue }
    if (trimmed.includes('Generic Fantasy Realms -Suffixes')) { section = 'realms_generic_suf'; continue }
    if (trimmed.includes('Names for “Good” Realms')) { section = 'realms_good'; continue }
    if (trimmed.includes('Names for “Evil” Realms')) { section = 'realms_evil'; continue }
    if (trimmed.includes('A Few Bits and Pieces for “Magical” Realms')) { section = 'realms_magical'; continue }
    if (trimmed.includes('Dwarven Place Names')) { section = 'dwarf'; continue }
    if (trimmed.includes('Elvish Place Names')) { section = 'elf'; continue }
    if (trimmed.includes('Halfling Place Names')) { section = 'halfling'; continue }
    if (trimmed.includes('Orcish Place Names')) { section = 'orc'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('You can') || trimmed.startsWith('Feel free') || trimmed.includes('Terminal') || trimmed.includes('Prefix') || trimmed.includes('Suffix')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))

    if (section === 'realms_generic_pre') {
      if (textCols.length >= 2) {
        splitCell(textCols[0]).forEach(t => { if (!realms.generic.prefixes.includes(t)) realms.generic.prefixes.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!realms.generic.centers.includes(t)) realms.generic.centers.push(t) })
      } else if (textCols.length === 1) {
        splitCell(textCols[0]).forEach(t => { if (!realms.generic.prefixes.includes(t)) realms.generic.prefixes.push(t) })
      }
    } else if (section === 'realms_generic_suf') {
      for (const col of textCols) {
        splitCell(col).forEach(t => { if (!realms.generic.suffixes.includes(t)) realms.generic.suffixes.push(t) })
      }
    } else if (['realms_good', 'realms_evil', 'realms_magical', 'dwarf', 'elf'].includes(section)) {
      const target = section.startsWith('realms_') ? realms[section.replace('realms_', '')] : ancestral[section]
      if (textCols.length >= 3) {
        splitCell(textCols[0]).forEach(t => { if (!target.prefixes.includes(t)) target.prefixes.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!target.centers.includes(t)) target.centers.push(t) })
        splitCell(textCols[2]).forEach(t => { if (!target.suffixes.includes(t)) target.suffixes.push(t) })
      } else if (textCols.length === 2) {
        splitCell(textCols[0]).forEach(t => { if (!target.prefixes.includes(t)) target.prefixes.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!target.suffixes.includes(t)) target.suffixes.push(t) })
      }
    } else if (['halfling', 'orc'].includes(section)) {
      if (textCols.length >= 2) {
        splitCell(textCols[0]).forEach(t => { if (!ancestral[section].prefixes.includes(t)) ancestral[section].prefixes.push(t) })
        splitCell(textCols[1]).forEach(t => { if (!ancestral[section].suffixes.includes(t)) ancestral[section].suffixes.push(t) })
      }
    }
  }

  return { realms, ancestral }
}

function parseTerrains() {
  const lines = readLines('Fantasy Location Names by Terrain Type.txt')
  const terrains = {
    arctic: { regions: [], places: [] },
    coastal: { regions: [], places: [] },
    desert: { regions: [], places: [] },
    forest: { regions: [], places: [], trees: [] },
    hill: { regions: [], places: [] },
    jungle: { regions: [], places: [] },
    lake: { regions: [] },
    mountain: { regions: [], places: [] },
    ocean: { regions: ['Ocean', 'Sea', 'Deep', 'Reach', 'Waters', 'Expanse'], places: [] },
    plains: { regions: [], places: [] },
    river: { regions: [], places: [] },
    road: { regions: [], places: [] },
    swamp: { regions: [], places: [] },
  }

  let currentTerrain = ''
  let currentField = 'regions'

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed === 'Arctic Regions') { currentTerrain = 'arctic'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places in Arctic Regions') { currentField = 'places'; continue }
    if (trimmed === 'Beaches and Coastal Regions') { currentTerrain = 'coastal'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places on Coasts') { currentField = 'places'; continue }
    if (trimmed === 'Deserts and Desert Regions') { currentTerrain = 'desert'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places in Deserts') { currentField = 'places'; continue }
    if (trimmed === 'Forests and Woods') { currentTerrain = 'forest'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Forests') { currentField = 'places'; continue }
    if (trimmed === 'Trees') { currentField = 'trees'; continue }
    if (trimmed === 'Hill Regions') { currentTerrain = 'hill'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Hill Regions') { currentField = 'places'; continue }
    if (trimmed === 'Jungles and Jungle Regions' || trimmed === 'Jungles and Jungle regions') { currentTerrain = 'jungle'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Jungle Regions') { currentField = 'places'; continue }
    if (trimmed === 'Lakes and Lake Regions') { currentTerrain = 'lake'; currentField = 'regions'; continue }
    if (trimmed === 'Mountain Regions') { currentTerrain = 'mountain'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Mountain Regions') { currentField = 'places'; continue }
    if (trimmed === 'Ocean Regions') { currentTerrain = 'ocean'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Ocean Regions') { currentField = 'places'; continue }
    if (trimmed === 'Plains Regions') { currentTerrain = 'plains'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Plains Regions') { currentField = 'places'; continue }
    if (trimmed === 'Terms for Plains') { currentField = 'regions'; continue }
    if (trimmed === 'Rivers and River Regions') { currentTerrain = 'river'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within River Regions') { currentField = 'places'; continue }
    if (trimmed === 'Roads') { currentTerrain = 'road'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Road Regions' || trimmed.includes('Terms for Streets')) { currentField = 'places'; continue }
    if (trimmed === 'Swamps') { currentTerrain = 'swamp'; currentField = 'regions'; continue }
    if (trimmed === 'Terms for Places within Swamp Regions') { currentField = 'places'; continue }

    if (
      trimmed.startsWith('Roll') ||
      trimmed.startsWith('Terms for') ||
      trimmed.startsWith('Name-forms') ||
      trimmed.startsWith('On the Coast') ||
      trimmed.includes('General \tSettled') ||
      trimmed.includes('Greater \tSmaller') ||
      (trimmed.includes('Greater') && trimmed.includes('Smaller')) ||
      trimmed.includes('(Die roller)')
    ) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))
    for (const col of textCols) {
      splitCell(col).filter(t => t.length > 1).forEach(t => {
        if (currentTerrain && terrains[currentTerrain] && terrains[currentTerrain][currentField]) {
          if (!terrains[currentTerrain][currentField].includes(t)) {
            terrains[currentTerrain][currentField].push(t)
          }
        }
      })
    }
  }

  return terrains
}

function parseThemes() {
  const lines = readLines('Fantasy Location Names by Theme.txt')
  const themeList = [
    'beautiful', 'civilized', 'cultured', 'dangerous', 'haunted',
    'historical', 'infernal', 'magical', 'militaristic', 'monstrous',
    'oppressed', 'poor', 'religious', 'rich', 'safe', 'underworld'
  ]
  const themes = {}
  themeList.forEach(t => { themes[t] = [] })

  let currentTheme = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const lower = trimmed.toLowerCase()
    if (themeList.includes(lower)) {
      currentTheme = lower
      continue
    }

    if (
      trimmed.startsWith('Roll') ||
      trimmed.startsWith('If you') ||
      trimmed.startsWith('For a') ||
      trimmed.startsWith('This page') ||
      trimmed.startsWith('Fantasy Location') ||
      trimmed.includes('(die roller)') ||
      trimmed.includes('(Die roller)')
    ) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]+(\s+[0-9]+)?$/.test(c))
    for (const col of textCols) {
      // Split by slash and clean
      splitCell(col).forEach(t => {
        if (currentTheme && themes[currentTheme]) {
          // clean any lingering dash suffixes like "Aw-e-estruck-ful" -> simplified
          const simplified = t.replace(/-/g, '')
          if (simplified && simplified.length > 1 && !themes[currentTheme].includes(simplified)) {
            themes[currentTheme].push(simplified)
          }
        }
      })
    }
  }

  return themes
}

function parseRegions() {
  const lines = readLines('Fantasy Location Names By Region Type.txt')
  const regions = {
    tiny: [], vast: [], civilized: [], wilderness: [],
    monstrous: [], northern: [], southern: [], eastern: [], western: [],
  }

  let current = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed === 'Tiny') { current = 'tiny'; continue }
    if (trimmed === 'Vast') { current = 'vast'; continue }
    if (trimmed === 'Civilized') { current = 'civilized'; continue }
    if (trimmed === 'Wilderness') { current = 'wilderness'; continue }
    if (trimmed === 'Monstrous') { current = 'monstrous'; continue }
    if (trimmed.includes('Northern')) { current = 'northern'; continue }
    if (trimmed.includes('Southern')) { current = 'southern'; continue }
    if (trimmed.includes('Eastern')) { current = 'eastern'; continue }
    if (trimmed.includes('Western')) { current = 'western'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('Either') || trimmed.includes('Tiny / Vast')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))
    for (const col of textCols) {
      splitCell(col).forEach(t => {
        if (current && regions[current]) {
          const simplified = t.replace(/-/g, '')
          if (simplified && !regions[current].includes(simplified)) {
            regions[current].push(simplified)
          }
        }
      })
    }
  }

  return regions
}

function parseMisc() {
  const lines = readLines('Fantasy Location Names – Miscellaneous.txt')
  const misc = {
    colors: [],
    shapes: [],
    rulers: [],
    modifiers: [],
  }

  let current = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed === 'Colors' || trimmed === 'More Colors') { current = 'colors'; continue }
    if (trimmed === 'Shapes') { current = 'shapes'; continue }
    if (trimmed === 'Rulers') { current = 'rulers'; continue }
    if (trimmed.includes('Miscellaneous Modifiers')) { current = 'modifiers'; continue }

    if (trimmed.startsWith('Roll') || trimmed.startsWith('This table') || trimmed.startsWith('Either') || trimmed.includes('Feudal \tNorthern')) continue

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    const textCols = cols.filter(c => !/^[0-9]/.test(c))
    for (const col of textCols) {
      splitCell(col).forEach(t => {
        if (current && misc[current]) {
          if (!misc[current].includes(t)) {
            misc[current].push(t)
          }
        }
      })
    }
  }

  return misc
}

console.log('Extracting complete names dataset from 12 text files...')
const dwarven = parseDwarven()
const elvish = parseElvish()
const halfling = parseHalfling()
const humanFantasy = parseHumanFantasy()
const humanHistorical = parseHumanHistorical()
const authors = parseAuthors()
const townEnglish = parseTownsEnglish()
const properLocs = parseProperLocations()
const terrains = parseTerrains()
const themes = parseThemes()
const regions = parseRegions()
const misc = parseMisc()

const fullData = {
  characters: {
    dwarf: dwarven,
    elf: elvish,
    halfling,
    human_fantasy: humanFantasy,
    human_historical: humanHistorical,
    authors,
  },
  places: {
    settlements_english: townEnglish,
    realms: properLocs.realms,
    ancestral: properLocs.ancestral,
    terrains,
    themes,
    regions,
    misc,
  },
}

writeFileSync(OUT_FILE, JSON.stringify(fullData, null, 2), 'utf8')
console.log(`Successfully compiled names-data.json: ${(JSON.stringify(fullData).length / 1024).toFixed(1)} KB`)
