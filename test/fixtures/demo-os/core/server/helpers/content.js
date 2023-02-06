// # Content Helper
// Usage: `{{content}}`, `{{content words="20"}}`, `{{content characters="256"}}`
//
// Turns content html into a safestring so that the user doesn't have to
// escape it or tell handlebars to leave it alone with a triple-brace.
//
// Enables tag-safe truncation of content by characters or words.

const hbs = require('express-hbs')
const _ = require('lodash')
const downsize = require('downsize')
const downzero = require('../utils/downzero')
let content

content = function (options) {
  let truncateOptions = (options || {}).hash || {}
  truncateOptions = _.pick(truncateOptions, ['words', 'characters'])
  _.keys(truncateOptions).map(function (key) {
    truncateOptions[key] = parseInt(truncateOptions[key], 10)
  })

  if (Object.prototype.hasOwnProperty.call(truncateOptions, 'words') || Object.prototype.hasOwnProperty.call(truncateOptions, 'characters')) {
    // Legacy function: {{content words="0"}} should return leading tags.
    if (Object.prototype.hasOwnProperty.call(truncateOptions, 'words') && truncateOptions.words === 0) {
      return new hbs.handlebars.SafeString(
        downzero(this.html)
      )
    }

    return new hbs.handlebars.SafeString(
      downsize(this.html, truncateOptions)
    )
  }

  return new hbs.handlebars.SafeString(this.html)
}

module.exports = content
