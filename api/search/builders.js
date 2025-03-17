import { LIMIT } from '@/api/search/utils'
import { whenToFrom } from '@/lib/time'
import { queryParts } from '@/api/search/utils'

export async function buildRelatedQuery({ title, id, decodedCursor, limit = LIMIT, minMatch, getItem, me, models }) {
  const like = []
  if (id) {
    like.push({
      _index: process.env.OPENSEARCH_INDEX,
      _id: id
    })
  }

  if (title) {
    like.push(title)
  }

  const mustNot = [{ exists: { field: 'parentId' } }]
  if (id) {
    mustNot.push({ term: { id } })
  }

  let should = [
    {
      more_like_this: {
        fields: ['title', 'text'],
        like,
        min_term_freq: 1,
        min_doc_freq: 1,
        max_doc_freq: 5,
        min_word_length: 2,
        max_query_terms: 25,
        minimum_should_match: minMatch || '10%',
        boost_terms: 100
      }
    }
  ]

  if (process.env.OPENSEARCH_MODEL_ID) {
    let qtitle = title
    let qtext = title
    if (id) {
      const item = await getItem(null, { id }, { me, models })
      qtitle = item.title || item.text
      qtext = item.text || item.title
    }

    should = [
      {
        neural: {
          title_embedding: {
            query_text: qtext,
            model_id: process.env.OPENSEARCH_MODEL_ID,
            k: decodedCursor.offset + LIMIT
          }
        }
      },
      {
        neural: {
          text_embedding: {
            query_text: qtitle,
            model_id: process.env.OPENSEARCH_MODEL_ID,
            k: decodedCursor.offset + LIMIT
          }
        }
      }
    ]
  }

  return {
    index: process.env.OPENSEARCH_INDEX,
    size: limit,
    from: decodedCursor.offset,
    _source: {
      excludes: [
        'text',
        'text_embedding',
        'title_embedding'
      ]
    },
    body: {
      query: {
        function_score: {
          query: {
            bool: {
              should,
              filter: [
                {
                  bool: {
                    should: [
                      { match: { status: 'ACTIVE' } },
                      { match: { status: 'NOSATS' } }
                    ],
                    must_not: mustNot
                  }
                },
                {
                  range: { wvotes: { gte: minMatch ? 0 : 0.2 } }
                }
              ]
            }
          },
          functions: [{
            field_value_factor: {
              field: 'wvotes',
              modifier: 'none',
              factor: 1,
              missing: 0
            }
          }],
          boost_mode: 'multiply'
        }
      }
    }
  }
}

export function buildSearchQuery({ 
  q,
  sort, 
  what, 
  when,
  from: whenFrom,
  to: whenTo,
  decodedCursor, 
  me
}) {
  // Process the query parts
  const { query: _query, quotes, nym, url, territory } = queryParts(q)
  let query = _query

  const isUrlSearch = url && query.length === 0 // exclusively searching for an url

  // URL processing logic - moved from resolver
  if (url) {
    const isFQDN = url.startsWith('url:www.')
    const domain = isFQDN ? url.slice(8) : url.slice(4)
    const fqdn = `www.${domain}`
    query = (isUrlSearch) ? `${domain} ${fqdn}` : `${query.trim()} ${domain}`
  }

  // Calculate whenRange - moved from resolver
  const whenRange = when === 'custom'
    ? {
        gte: whenFrom,
        lte: new Date(Math.min(new Date(Number(whenTo)), decodedCursor.time))
      }
    : {
        lte: decodedCursor.time,
        gte: whenToFrom(when)
      }

  let termQueries = []
  const whatArr = []
  
  // Content type filtering (posts, comments, bookmarks)
  switch (what) {
    case 'posts':
      whatArr.push({ bool: { must_not: { exists: { field: 'parentId' } } } })
      break
    case 'comments':
      whatArr.push({ bool: { must: { exists: { field: 'parentId' } } } })
      break
    case 'bookmarks':
      if (me?.id) {
        whatArr.push({ match: { bookmarkedBy: me?.id } })
      }
      break
    default:
      break
  }

  if (nym) {
    whatArr.push({ wildcard: { 'user.name': `*${nym.slice(1).toLowerCase()}*` } })
  }

  if (territory) {
    whatArr.push({ match: { 'sub.name': territory.slice(1) } })
  }

  if (query.length) {
    termQueries.push({
      // all terms are matched in fields
      multi_match: {
        query,
        type: 'best_fields',
        fields: ['title^100', 'text'],
        minimum_should_match: (isUrlSearch) ? 1 : '100%',
        boost: 1000
      }
    })
  }

  for (const quote of quotes) {
    whatArr.push({
      multi_match: {
        query: quote,
        type: 'phrase',
        fields: ['title', 'text']
      }
    })
  }

  // if we search for an exact string only, everything must match
  // so score purely on sort field
  let boostMode = query ? 'multiply' : 'replace'
  let sortField
  let sortMod = 'log1p'
  switch (sort) {
    case 'comments':
      sortField = 'ncomments'
      sortMod = 'square'
      break
    case 'sats':
      sortField = 'sats'
      break
    case 'recent':
      sortField = 'createdAt'
      sortMod = 'square'
      boostMode = 'replace'
      break
    default:
      sortField = 'wvotes'
      sortMod = 'none'
      break
  }

  const functions = [
    {
      field_value_factor: {
        field: sortField,
        modifier: sortMod,
        factor: 1.2
      }
    }
  ]

  if (sort === 'recent' && !isUrlSearch) {
    // prioritize exact matches
    termQueries.push({
      multi_match: {
        query,
        type: 'phrase',
        fields: ['title^100', 'text'],
        boost: 1000
      }
    })
  } else {
    // allow fuzzy matching with partial matches
    termQueries.push({
      multi_match: {
        query,
        type: 'most_fields',
        fields: ['title^100', 'text'],
        fuzziness: 'AUTO',
        prefix_length: 3,
        minimum_should_match: (isUrlSearch) ? 1 : '60%'
      }
    })
    functions.push(
      {
        // small bias toward posts with comments
        field_value_factor: {
          field: 'ncomments',
          modifier: 'ln1p',
          factor: 1
        }
      },
      {
        // small bias toward recent posts
        field_value_factor: {
          field: 'createdAt',
          modifier: 'log1p',
          factor: 1
        }
      }
    )
  }

  if (query.length) {
    // if we have a model id and we aren't sort by recent, use neural search
    if (process.env.OPENSEARCH_MODEL_ID && sort !== 'recent') {
      termQueries = {
        hybrid: {
          queries: [
            {
              bool: {
                should: [
                  {
                    neural: {
                      title_embedding: {
                        query_text: query,
                        model_id: process.env.OPENSEARCH_MODEL_ID,
                        k: decodedCursor.offset + LIMIT
                      }
                    }
                  },
                  {
                    neural: {
                      text_embedding: {
                        query_text: query,
                        model_id: process.env.OPENSEARCH_MODEL_ID,
                        k: decodedCursor.offset + LIMIT
                      }
                    }
                  }
                ]
              }
            },
            {
              bool: {
                should: termQueries
              }
            }
          ]
        }
      }
    }
  } else {
    termQueries = []
  }

  return {
    index: process.env.OPENSEARCH_INDEX,
    size: LIMIT,
    _source: {
      excludes: [
        'text',
        'text_embedding',
        'title_embedding'
      ]
    },
    from: decodedCursor.offset,
    body: {
      query: {
        function_score: {
          query: {
            bool: {
              must: termQueries,
              filter: [
                ...whatArr,
                me
                  ? {
                      bool: {
                        should: [
                          { match: { status: 'ACTIVE' } },
                          { match: { status: 'NOSATS' } },
                          { match: { userId: me.id } }
                        ]
                      }
                    }
                  : {
                      bool: {
                        should: [
                          { match: { status: 'ACTIVE' } },
                          { match: { status: 'NOSATS' } }
                        ]
                      }
                    },
                {
                  range:
                  {
                    createdAt: whenRange
                  }
                },
                { range: { wvotes: { gte: 0 } } }
              ]
            }
          },
          functions,
          boost_mode: boostMode
        }
      },
      highlight: {
        fields: {
          title: { number_of_fragments: 0, pre_tags: ['***'], post_tags: ['***'] },
          text: { number_of_fragments: 5, order: 'score', pre_tags: ['***'], post_tags: ['***'] }
        }
      }
    }
  }
}

