// # Date Helper
// Usage: `{{date format="DD MM, YYYY"}}`, `{{date updated_at format="DD MM, YYYY"}}`
//
// Formats a date using moment.js. Formats published_at by default but will also take a date as a parameter

const moment = require('moment')
let date

date = function (context, options) {
  if (!options && Object.prototype.hasOwnProperty.call(context, 'hash')) {
    options = context
    context = undefined

    // set to published_at by default, if it's available
    // otherwise, this will print the current date
    if (this.published_at) {
      context = this.published_at
    }
  }

  // ensure that context is undefined, not null, as that can cause errors
  context = context === null ? undefined : context

  const f = options.hash.format || 'MMM Do, YYYY'
  const timeago = options.hash.timeago
  let date

  if (timeago) {
    date = moment(context).fromNow()
  } else {
    date = moment(context).format(f)
  }
  return date
}

module.exports = date
