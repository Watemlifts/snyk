const templates = {}
const hbs = require('express-hbs')
const errors = require('../errors')

// ## Template utils

// Execute a template helper
// All template helpers are register as partial view.
templates.execute = function (name, context, options) {
  const partial = hbs.handlebars.partials[name]

  if (partial === undefined) {
    errors.logAndThrowError('Template ' + name + ' not found.')
    return
  }

  // If the partial view is not compiled, it compiles and saves in handlebars
  if (typeof partial === 'string') {
    hbs.registerPartial(partial)
  }

  return new hbs.handlebars.SafeString(partial(context, options))
}

// Given a theme object and a post object this will return
// which theme template page should be used.
// If given a post object that is a regular post
// it will return 'post'.
// If given a static post object it will return 'page'.
// If given a static post object and a custom page template
// exits it will return that page.
templates.getThemeViewForPost = function (themePaths, post) {
  const customPageView = 'page-' + post.slug
  let view = 'post'

  if (post.page) {
    if (Object.prototype.hasOwnProperty.call(themePaths, customPageView + '.hbs')) {
      view = customPageView
    } else if (Object.prototype.hasOwnProperty.call(themePaths, 'page.hbs')) {
      view = 'page'
    }
  }

  return view
}

// Given a theme object and a slug this will return
// which theme template page should be used.
// If no default or custom tag template exists then 'index'
// will be returned
// If no custom template exists but a default does then
// the default will be returned
// If given a slug and a custom template
// exits it will return that view.
templates.getThemeViewForChannel = function (themePaths, channelName, slug) {
  const customChannelView = channelName + '-' + slug
  let view = channelName

  if (Object.prototype.hasOwnProperty.call(themePaths, customChannelView + '.hbs')) {
    view = customChannelView
  } else if (!Object.prototype.hasOwnProperty.call(themePaths, channelName + '.hbs')) {
    view = 'index'
  }

  return view
}

module.exports = templates
