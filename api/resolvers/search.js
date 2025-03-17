import { decodeCursor, LIMIT, nextCursorEncoded } from '@/lib/cursor'
import { getItem, itemQueryWithMeta, SELECT } from './item'

// Just import the builder functions - no need for queryParts anymore
import { buildRelatedQuery, buildSearchQuery } from '@/api/search/builders'

export default {
  Query: {
    related: async (parent, { title, id, cursor, limit = LIMIT, minMatch }, { me, models, search }) => {
      const decodedCursor = decodeCursor(cursor)

      if (!id && (!title || title.trim().split(/\s+/).length < 1)) {
        return {
          items: [],
          cursor: null
        }
      }

      // Use the builder function from the new module
      const searchParams = await buildRelatedQuery({
        title, 
        id, 
        decodedCursor, 
        limit, 
        minMatch,
        getItem,
        me,
        models
      })

      const results = await search.search(searchParams)

      const values = results.body.hits.hits.map((e, i) => {
        return `(${e._source.id}, ${i})`
      }).join(',')

      if (values.length === 0) {
        return {
          cursor: null,
          items: []
        }
      }

      const items = await itemQueryWithMeta({
        me,
        models,
        query: `
          WITH r(id, rank) AS (VALUES ${values})
          ${SELECT}, rank
          FROM "Item"
          JOIN r ON "Item".id = r.id`,
        orderBy: 'ORDER BY rank ASC'
      })

      return {
        cursor: items.length === (limit || LIMIT) ? nextCursorEncoded(decodedCursor) : null,
        items
      }
    },
    search: async (parent, { q, cursor, sort, what, when, from, to }, { me, models, search }) => {
      const decodedCursor = decodeCursor(cursor)
      let sitems = null

      // short circuit: return empty result if either:
      // 1. no query provided, or
      // 2. searching bookmarks without being authed
      if (!q || (what === 'bookmarks' && !me)) {
        return {
          items: [],
          cursor: null
        }
      }

      try {
        // Use the enhanced builder function that now handles all query processing
        sitems = await search.search(
          buildSearchQuery({
            q,
            sort,
            what,
            when,
            from,
            to,
            decodedCursor,
            me
          })
        )
      } catch (e) {
        console.log(e)
        return {
          cursor: null,
          items: []
        }
      }

      const values = sitems.body.hits.hits.map((e, i) => {
        return `(${e._source.id}, ${i})`
      }).join(',')

      if (values.length === 0) {
        return {
          cursor: null,
          items: []
        }
      }

      const items = (await itemQueryWithMeta({
        me,
        models,
        query: `
          WITH r(id, rank) AS (VALUES ${values})
          ${SELECT}, rank
          FROM "Item"
          JOIN r ON "Item".id = r.id`,
        orderBy: 'ORDER BY rank ASC'
      })).map((item, i) => {
        const e = sitems.body.hits.hits[i]
        item.searchTitle = (e.highlight?.title && e.highlight.title[0]) || item.title
        item.searchText = (e.highlight?.text && e.highlight.text.join(' ... ')) || undefined
        return item
      })

      return {
        cursor: items.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        items
      }
    }
  }
}
