// # CacheControl Middleware
// Usage: cacheControl(profile), where profile is one of 'public' or 'private'
// After: checkIsPrivate
// Before: routes
// App: Admin|Blog|API
//
// Allows each app to declare its own default caching rules

const _ = require('lodash')
let cacheControl

cacheControl = function cacheControl (options) {
  /* jslint unparam:true */
  const profiles = {
    public: 'public, max-age=0',
    private: 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0'
  }
  let output

  if (_.isString(options) && Object.prototype.hasOwnProperty.call(profiles, options)) {
    output = profiles[options]
  }

  return function cacheControlHeaders (req, res, next) {
    if (output) {
      if (res.isPrivateBlog) {
        res.set({ 'Cache-Control': profiles.private })
      } else {
        res.set({ 'Cache-Control': output })
      }
    }
    next()
  }
}

module.exports = cacheControl
