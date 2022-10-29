const _ = require('lodash')
const Promise = require('bluebird')
const cheerio = require('cheerio')
const crypto = require('crypto')
const downsize = require('downsize')
const RSS = require('rss')
const url = require('url')
const config = require('../../../config')
const api = require('../../../api')
const filters = require('../../../filters')

let generate
let generateFeed
let getFeedXml
const feedCache = {}

function isTag (req) {
  return req.originalUrl.indexOf('/' + config.routeKeywords.tag + '/') !== -1
}

function isAuthor (req) {
  return req.originalUrl.indexOf('/' + config.routeKeywords.author + '/') !== -1
}

function handleError (next) {
  return function handleError (err) {
    return next(err)
  }
}

function getOptions (req, pageParam, slugParam) {
  const options = {}

  if (pageParam) { options.page = pageParam }
  if (isTag(req)) { options.tag = slugParam }
  if (isAuthor(req)) { options.author = slugParam }

  options.include = 'author,tags,fields'

  return options
}

function getData (options) {
  const ops = {
    title: api.settings.read('title'),
    description: api.settings.read('description'),
    permalinks: api.settings.read('permalinks'),
    results: api.posts.browse(options)
  }

  return Promise.props(ops).then(function (result) {
    let titleStart = ''
    if (options.tag) { titleStart = result.results.meta.filters.tags[0].name + ' - ' || '' }
    if (options.author) { titleStart = result.results.meta.filters.author.name + ' - ' || '' }

    return {
      title: titleStart + result.title.settings[0].value,
      description: result.description.settings[0].value,
      permalinks: result.permalinks.settings[0],
      results: result.results
    }
  })
}

function getBaseUrl (req, slugParam) {
  let baseUrl = config.paths.subdir

  if (isTag(req)) {
    baseUrl += '/' + config.routeKeywords.tag + '/' + slugParam + '/rss/'
  } else if (isAuthor(req)) {
    baseUrl += '/' + config.routeKeywords.author + '/' + slugParam + '/rss/'
  } else {
    baseUrl += '/rss/'
  }

  return baseUrl
}

function processUrls (html, siteUrl, itemUrl) {
  const htmlContent = cheerio.load(html, { decodeEntities: false });
  // convert relative resource urls to absolute
  ['href', 'src'].forEach(function forEach (attributeName) {
    htmlContent('[' + attributeName + ']').each(function each (ix, el) {
      let baseUrl,
        attributeValue,
        parsed

      el = htmlContent(el)

      attributeValue = el.attr(attributeName)

      // if URL is absolute move on to the next element
      try {
        parsed = url.parse(attributeValue)

        if (parsed.protocol) {
          return
        }
      } catch (e) {
        return
      }

      // compose an absolute URL

      // if the relative URL begins with a '/' use the blog URL (including sub-directory)
      // as the base URL, otherwise use the post's URL.
      baseUrl = attributeValue[0] === '/' ? siteUrl : itemUrl
      attributeValue = config.urlJoin(baseUrl, attributeValue)
      el.attr(attributeName, attributeValue)
    })
  })

  return htmlContent
}

getFeedXml = function getFeedXml (path, data) {
  const dataHash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')
  if (!feedCache[path] || feedCache[path].hash !== dataHash) {
    // We need to regenerate
    feedCache[path] = {
      hash: dataHash,
      xml: generateFeed(data)
    }
  }

  return feedCache[path].xml
}

generateFeed = function generateFeed (data) {
  const feed = new RSS({
    title: data.title,
    description: data.description,
    generator: 'Ghost ' + data.version,
    feed_url: data.feedUrl,
    site_url: data.siteUrl,
    ttl: '60',
    custom_namespaces: {
      content: 'http://purl.org/rss/1.0/modules/content/',
      media: 'http://search.yahoo.com/mrss/'
    }
  })

  data.results.posts.forEach(function forEach (post) {
    const itemUrl = config.urlFor('post', { post, permalinks: data.permalinks, secure: data.secure }, true)
    const htmlContent = processUrls(post.html, data.siteUrl, itemUrl)
    const item = {
      title: post.title,
      description: post.meta_description || downsize(htmlContent.html(), { words: 50 }),
      guid: post.uuid,
      url: itemUrl,
      date: post.published_at,
      categories: _.pluck(post.tags, 'name'),
      author: post.author ? post.author.name : null,
      custom_elements: []
    }
    let imageUrl

    if (post.image) {
      imageUrl = config.urlFor('image', { image: post.image, secure: data.secure }, true)

      // Add a media content tag
      item.custom_elements.push({
        'media:content': {
          _attr: {
            url: imageUrl,
            medium: 'image'
          }
        }
      })

      // Also add the image to the content, because not all readers support media:content
      htmlContent('p').first().before('<img src="' + imageUrl + '" />')
      htmlContent('img').attr('alt', post.title)
    }

    item.custom_elements.push({
      'content:encoded': {
        _cdata: htmlContent.html()
      }
    })

    filters.doFilter('rss.item', item, post).then(function then (item) {
      feed.item(item)
    })
  })

  return filters.doFilter('rss.feed', feed).then(function then (feed) {
    return feed.xml()
  })
}

generate = function generate (req, res, next) {
  // Initialize RSS
  const pageParam = req.params.page !== undefined ? parseInt(req.params.page, 10) : 1
  const slugParam = req.params.slug
  const baseUrl = getBaseUrl(req, slugParam)
  const options = getOptions(req, pageParam, slugParam)

  // No negative pages, or page 1
  if (isNaN(pageParam) || pageParam < 1 || (req.params.page !== undefined && pageParam === 1)) {
    return res.redirect(baseUrl)
  }

  return getData(options).then(function then (data) {
    const maxPage = data.results.meta.pagination.pages

    // If page is greater than number of pages we have, redirect to last page
    if (pageParam > maxPage) {
      return res.redirect(baseUrl + maxPage + '/')
    }

    data.version = res.locals.safeVersion
    data.siteUrl = config.urlFor('home', { secure: req.secure }, true)
    data.feedUrl = config.urlFor({ relativeUrl: baseUrl, secure: req.secure }, true)
    data.secure = req.secure

    return getFeedXml(req.originalUrl, data).then(function then (feedXml) {
      res.set('Content-Type', 'text/xml; charset=UTF-8')
      res.send(feedXml)
    })
  }).catch(handleError(next))
}

module.exports = generate
