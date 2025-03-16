
function queryParts (q) {
    const regex = /"([^"]*)"/gm
  
    const queryArr = q.replace(regex, '').trim().split(/\s+/)
    const url = queryArr.find(word => word.startsWith('url:'))
    const nym = queryArr.find(word => word.startsWith('@'))
    const territory = queryArr.find(word => word.startsWith('~'))
    const exclude = [url, nym, territory]
    const query = queryArr.filter(word => !exclude.includes(word)).join(' ')
  
    return {
      quotes: [...q.matchAll(regex)].map(m => m[1]),
      nym,
      url,
      territory,
      query
    }
  }
