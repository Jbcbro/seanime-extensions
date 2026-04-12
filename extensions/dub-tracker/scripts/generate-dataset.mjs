#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataPath = path.resolve(__dirname, "../data/counts.json")

const ANILIST_URL = "https://graphql.anilist.co"
const HIANIME_SEARCH_URL = "https://aniwatch-api.jc-server.com/api/v2/hianime/search?q="

const NOW = new Date()
const CURRENT_YEAR = NOW.getUTCFullYear()
const CURRENT_MONTH = NOW.getUTCMonth() + 1

function getSeason(month) {
    if (month <= 3) return "WINTER"
    if (month <= 6) return "SPRING"
    if (month <= 9) return "SUMMER"
    return "FALL"
}

function getSeasonOrder(season) {
    return ["WINTER", "SPRING", "SUMMER", "FALL"].indexOf(season)
}

function getPreviousSeasonAndYear(season, year) {
    const seasons = ["WINTER", "SPRING", "SUMMER", "FALL"]
    const idx = seasons.indexOf(season)
    if (idx <= 0) return { season: "FALL", year: year - 1 }
    return { season: seasons[idx - 1], year }
}

function normalizeTitle(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.json()
}

async function fetchCandidates() {
    const currentSeason = getSeason(CURRENT_MONTH)
    const previousSeason = getPreviousSeasonAndYear(currentSeason, CURRENT_YEAR)

    const query = `
        query CandidateMedia(
            $page: Int!,
            $perPage: Int!,
            $season: MediaSeason,
            $seasonYear: Int,
            $status: MediaStatus,
            $sort: [MediaSort]
        ) {
            Page(page: $page, perPage: $perPage) {
                media(type: ANIME, season: $season, seasonYear: $seasonYear, status: $status, sort: $sort) {
                    id
                    status
                    title {
                        english
                        romaji
                        native
                    }
                }
            }
        }
    `

    const requests = [
        { page: 1, perPage: 50, season: currentSeason, seasonYear: CURRENT_YEAR, sort: ["POPULARITY_DESC"] },
        { page: 1, perPage: 50, season: previousSeason.season, seasonYear: previousSeason.year, sort: ["POPULARITY_DESC"] },
        { page: 1, perPage: 50, status: "RELEASING", sort: ["POPULARITY_DESC"] },
        { page: 1, perPage: 50, status: "RELEASING", sort: ["TRENDING_DESC"] },
        { page: 1, perPage: 50, sort: ["TRENDING_DESC"] },
    ]

    const seen = new Map()
    for (const variables of requests) {
        const json = await postJson(ANILIST_URL, { query, variables })
        const media = json?.data?.Page?.media || []
        for (const item of media) {
            if (!item?.id) continue
            seen.set(String(item.id), item)
        }
    }

    return [...seen.values()].slice(0, 180)
}

async function fetchCountsForMedia(media) {
    const titles = [
        media?.title?.english,
        media?.title?.romaji,
        media?.title?.native,
    ].filter(Boolean)

    if (!titles.length) return null

    const primaryTitle = titles[0]
    const response = await fetch(HIANIME_SEARCH_URL + encodeURIComponent(primaryTitle))
    if (!response.ok) return null

    const json = await response.json()
    const animes = json?.data?.animes || []
    if (!animes.length) return null

    const normalizedTitles = titles.map(normalizeTitle)
    const match = animes.find((a) => normalizedTitles.includes(normalizeTitle(a?.name))) ||
        animes.find((a) => normalizedTitles.some((t) => normalizeTitle(a?.name).includes(t) || t.includes(normalizeTitle(a?.name)))) ||
        animes[0]

    const eps = match?.episodes
    if (!eps) return null

    return {
        title: match?.name || primaryTitle,
        status: media?.status || null,
        sub: typeof eps.sub === "number" ? eps.sub : 0,
        dub: typeof eps.dub === "number" ? eps.dub : 0,
    }
}

async function main() {
    const candidates = await fetchCandidates()
    const entries = {}
    const concurrency = 8
    let index = 0

    async function worker() {
        while (index < candidates.length) {
            const media = candidates[index++]
            const counts = await fetchCountsForMedia(media)
            if (!counts) continue

            entries[String(media.id)] = {
                title: counts.title,
                status: counts.status,
                sub: counts.sub,
                dub: counts.dub,
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))

    const payload = {
        generatedAt: new Date().toISOString(),
        source: "AniList + AniWatch-compatible API",
        coverage: {
            currentSeason: getSeason(CURRENT_MONTH),
            currentYear: CURRENT_YEAR,
            previousSeason: previousSeason.season,
            previousSeasonYear: previousSeason.year,
            candidateCount: candidates.length,
            entryCount: Object.keys(entries).length,
        },
        entries,
    }

    await fs.mkdir(path.dirname(dataPath), { recursive: true })
    await fs.writeFile(dataPath, JSON.stringify(payload, null, 4) + "\n")

    console.log(`Wrote ${Object.keys(entries).length} entries to ${dataPath}`)
}

const previousSeason = getPreviousSeasonAndYear(getSeason(CURRENT_MONTH), CURRENT_YEAR)

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
