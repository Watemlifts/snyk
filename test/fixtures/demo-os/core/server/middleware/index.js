// # Custom Middleware
// The following custom middleware functions cannot yet be unit tested, and as such are kept separate from
// the testable custom middleware functions in middleware.js

const api = require('../api')
const bodyParser = require('body-parser')
const config = require('../config')
const crypto = require('crypto')
const errors = require('../errors')
const express = require('express')
const fs = require('fs')
const hbs = require('express-hbs')
const logger = require('morgan')
const middleware = require('./middleware')
const path = require('path')
const routes = require('../routes')
const slashes = require('connect-slashes')
const storage = require('../storage')
const _ = require('lodash')
const passport = require('passport')
const oauth = require('./oauth')
const oauth2orize = require('oauth2orize')
let authStrategies = require('./auth-strategies')
const utils = require('../utils')
const sitemapHandler = require('../data/xml/sitemap/handler')
const decideIsAdmin = require('./decide-is-admin')
const uncapitalise = require('./uncapitalise')

let blogApp
let setupMiddleware

// ##Custom Middleware

// ### GhostLocals Middleware
// Expose the standard locals that every external page should have available,
// separating between the theme and the admin
function ghostLocals (req, res, next) {
  // Make sure we have a locals value.
  res.locals = res.locals || {}
  res.locals.version = config.ghostVersion
  res.locals.safeVersion = config.ghostVersion.match(/^(\d+\.)?(\d+)/)[0]
  // relative path from the URL
  res.locals.relativeUrl = req.path

  next()
}

// ### Activate Theme
// Helper for manageAdminAndTheme
function activateTheme (activeTheme) {
  let hbsOptions
  const themePartials = path.join(config.paths.themePath, activeTheme, 'partials')

  // clear the view cache
  blogApp.cache = {}

  // set view engine
  hbsOptions = {
    partialsDir: [config.paths.helperTemplates],
    onCompile: function onCompile (exhbs, source) {
      return exhbs.handlebars.compile(source, { preventIndent: true })
    }
  }

  fs.stat(themePartials, function stat (err, stats) {
    // Check that the theme has a partials directory before trying to use it
    if (!err && stats && stats.isDirectory()) {
      hbsOptions.partialsDir.push(themePartials)
    }
  })

  blogApp.engine('hbs', hbs.express3(hbsOptions))

  // Update user error template
  errors.updateActiveTheme(activeTheme)

  // Set active theme variable on the express server
  blogApp.set('activeTheme', activeTheme)
}

// ### configHbsForContext Middleware
// Setup handlebars for the current context (admin or theme)
function configHbsForContext (req, res, next) {
  let themeData = config.theme
  if (req.secure && config.urlSSL) {
    // For secure requests override .url property with the SSL version
    themeData = _.clone(themeData)
    themeData.url = config.urlSSL.replace(/\/$/, '')
  }

  hbs.updateTemplateOptions({ data: { blog: themeData } })

  if (config.paths.themePath && blogApp.get('activeTheme')) {
    blogApp.set('views', path.join(config.paths.themePath, blogApp.get('activeTheme')))
  }

  // Pass 'secure' flag to the view engine
  // so that templates can choose 'url' vs 'urlSSL'
  res.locals.secure = req.secure

  next()
}

// ### updateActiveTheme
// Updates the blogApp's activeTheme variable and subsequently
// activates that theme's views with the hbs templating engine if it
// is not yet activated.
function updateActiveTheme (req, res, next) {
  api.settings.read({ context: { internal: true }, key: 'activeTheme' }).then(function then (response) {
    const activeTheme = response.settings[0]

    // Check if the theme changed
    if (activeTheme.value !== blogApp.get('activeTheme')) {
      // Change theme
      if (!Object.prototype.hasOwnProperty.call(config.paths.availableThemes, activeTheme.value)) {
        if (!res.isAdmin) {
          // Throw an error if the theme is not available, but not on the admin UI
          return errors.throwError('The currently active theme ' + activeTheme.value + ' is missing.')
        } else {
          // At this point the activated theme is not present and the current
          // request is for the admin client.  In order to allow the user access
          // to the admin client we set an hbs instance on the app so that middleware
          // processing can continue.
          blogApp.engine('hbs', hbs.express3())
          errors.logWarn('The currently active theme "' + activeTheme.value + '" is missing.')

          return next()
        }
      } else {
        activateTheme(activeTheme.value)
      }
    }
    next()
  }).catch(function handleError (err) {
    // Trying to start up without the active theme present, setup a simple hbs instance
    // and render an error page straight away.
    blogApp.engine('hbs', hbs.express3())
    next(err)
  })
}

// Redirect to setup if no user exists
function redirectToSetup (req, res, next) {
  /* jslint unparam:true */

  api.authentication.isSetup().then(function then (exists) {
    if (!exists.setup[0].status && !req.path.match(/\/setup\//)) {
      return res.redirect(config.paths.subdir + '/ghost/setup/')
    }
    next()
  }).catch(function handleError (err) {
    return next(new Error(err))
  })
}

// ### ServeSharedFile Middleware
// Handles requests to robots.txt and favicon.ico (and caches them)
function serveSharedFile (file, type, maxAge) {
  let content
  const filePath = path.join(config.paths.corePath, 'shared', file)
  const re = /(\{\{blog-url\}\})/g

  return function serveSharedFile (req, res, next) {
    if (req.url === '/' + file) {
      if (content) {
        res.writeHead(200, content.headers)
        res.end(content.body)
      } else {
        fs.readFile(filePath, function readFile (err, buf) {
          if (err) {
            return next(err)
          }
          if (type === 'text/xsl' || type === 'text/plain') {
            buf = buf.toString().replace(re, config.url.replace(/\/$/, ''))
          }
          content = {
            headers: {
              'Content-Type': type,
              'Content-Length': buf.length,
              ETag: '"' + crypto.createHash('sha256').update(buf, 'utf8').digest('hex') + '"',
              'Cache-Control': 'public, max-age=' + maxAge
            },
            body: buf
          }
          res.writeHead(200, content.headers)
          res.end(content.body)
        })
      }
    } else {
      next()
    }
  }
}

setupMiddleware = function setupMiddleware (blogAppInstance, adminApp) {
  const logging = config.logging
  const corePath = config.paths.corePath
  const oauthServer = oauth2orize.createServer()

  // silence JSHint without disabling unused check for the whole file
  authStrategies = authStrategies

  // Cache express server instance
  blogApp = blogAppInstance
  middleware.cacheBlogApp(blogApp)
  middleware.api.cacheOauthServer(oauthServer)
  oauth.init(oauthServer, middleware.spamPrevention.resetCounter)

  // Make sure 'req.secure' is valid for proxied requests
  // (X-Forwarded-Proto header will be checked, if present)
  blogApp.enable('trust proxy')

  // Logging configuration
  if (logging !== false) {
    if (blogApp.get('env') !== 'development') {
      blogApp.use(logger('combined', logging))
    } else {
      blogApp.use(logger('dev', logging))
    }
  }

  // Favicon
  blogApp.use(serveSharedFile('favicon.ico', 'image/x-icon', utils.ONE_DAY_S))

  // Static assets
  blogApp.use('/shared', express.static(path.join(corePath, '/shared'), { maxAge: utils.ONE_HOUR_MS }))
  blogApp.use('/content/images', storage.getStorage().serve())
  blogApp.use('/public', express.static(path.join(corePath, '/built/public'), { maxAge: utils.ONE_YEAR_MS }))

  // First determine whether we're serving admin or theme content
  blogApp.use(decideIsAdmin)
  blogApp.use(updateActiveTheme)
  blogApp.use(configHbsForContext)

  // Admin only config
  blogApp.use('/ghost', express.static(config.paths.clientAssets, { maxAge: utils.ONE_YEAR_MS }))

  // Force SSL
  // NOTE: Importantly this is _after_ the check above for admin-theme static resources,
  //       which do not need HTTPS. In fact, if HTTPS is forced on them, then 404 page might
  //       not display properly when HTTPS is not available!
  blogApp.use(middleware.checkSSL)
  adminApp.set('views', config.paths.adminViews)

  // Theme only config
  blogApp.use(middleware.staticTheme())

  // Check if password protected blog
  blogApp.use(middleware.checkIsPrivate) // check if the blog is protected
  blogApp.use(middleware.filterPrivateRoutes)

  // Serve sitemap.xsl file
  blogApp.use(serveSharedFile('sitemap.xsl', 'text/xsl', utils.ONE_DAY_S))

  // Serve robots.txt if not found in theme
  blogApp.use(serveSharedFile('robots.txt', 'text/plain', utils.ONE_HOUR_S))

  // site map
  sitemapHandler(blogApp)

  // Add in all trailing slashes
  blogApp.use(slashes(true, {
    headers: {
      'Cache-Control': 'public, max-age=' + utils.ONE_YEAR_S
    }
  }))
  blogApp.use(uncapitalise)

  // Body parsing
  blogApp.use(bodyParser.json())
  blogApp.use(bodyParser.urlencoded({ extended: true }))

  blogApp.use(passport.initialize())

  // ### Caching
  // Blog frontend is cacheable
  blogApp.use(middleware.cacheControl('public'))
  // Admin shouldn't be cached
  adminApp.use(middleware.cacheControl('private'))
  // API shouldn't be cached
  blogApp.use(routes.apiBaseUri, middleware.cacheControl('private'))

  // enable authentication
  blogApp.use(middleware.authenticate)

  // local data
  blogApp.use(ghostLocals)

  // ### Routing
  // Set up API routes
  blogApp.use(routes.apiBaseUri, routes.api(middleware))

  // Mount admin express app to /ghost and set up routes
  adminApp.use(middleware.redirectToSetup)
  adminApp.use(routes.admin())
  blogApp.use('/ghost', adminApp)

  // Set up Frontend routes
  blogApp.use(routes.frontend(middleware))

  // ### Error handling
  // 404 Handler
  blogApp.use(errors.error404)

  // 500 Handler
  blogApp.use(errors.error500)
}

module.exports = setupMiddleware
// Export middleware functions directly
module.exports.middleware = middleware
// Expose middleware functions in this file as well
module.exports.middleware.redirectToSetup = redirectToSetup
