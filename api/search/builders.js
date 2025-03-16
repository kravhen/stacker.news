import { LIMIT } from '@/api/search/utils'

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

export function buildSearchQuery(params) {
  return params;
}

