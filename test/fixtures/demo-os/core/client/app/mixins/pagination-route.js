import Ember from 'ember';
var defaultPaginationSettings,
    PaginationRoute;

defaultPaginationSettings = {
    page: 1,
    limit: 15
};

PaginationRoute = Ember.Mixin.create({
    /**
     * Sets up pagination details
     * @param {object} settings specifies additional pagination details
     */
    setupPagination: function (settings) {
        settings = settings || {};
        for (var key in defaultPaginationSettings) {
            if (Object.prototype.hasOwnProperty.call(defaultPaginationSettings, key)) {
                if (!Object.prototype.hasOwnProperty.call(settings, key)) {
                    settings[key] = defaultPaginationSettings[key];
                }
            }
        }

        this.set('paginationSettings', settings);
        this.controller.set('paginationSettings', settings);
    }
});

export default PaginationRoute;
