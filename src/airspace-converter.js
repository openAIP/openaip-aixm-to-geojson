const checkTypes = require('check-types');
const convert = require('xml-js');
const {
    featureCollection: createFeatureCollection,
    polygon: createPolygon,
    point: createPoint,
    lineArc: createArc,
    bearing: calcBearing,
    lineString: createLineString,
    lineToPolygon,
    unkinkPolygon,
    area: getArea,
    envelope,
    distance,
    circle: createCircle,
} = require('@turf/turf');
const Coordinates = require('coordinate-parser');
const rewind = require('@mapbox/geojson-rewind');
const jsts = require('jsts');
const cleanDeep = require('clean-deep');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const ajvKeywords = require('ajv-keywords');

const DEFAULT_CONFIG = require('./default-config');
const ALLOWED_TYPES = ['CTA', 'TMA', 'CTR_P', 'CTR', 'ATZ', 'OTHER', 'D', 'P', 'R'];
const ALLOWED_LOCALTYPES = ['MATZ', 'GLIDER', 'RMZ', 'TMZ'];
const ALLOWED_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'NO'];
const REGEX_CEILING_SURFACE = /^(SFC)$/;
const REGEX_CEILING_FEET = /^(\d+(\.\d+)?)\s*(ft|FT)?\s*(SFC)?$/;
const REGEX_CEILING_FLIGHT_LEVEL = /^FL\s*(\d{2,})?$/;
const REGEX_COORDINATES = /^[0-9]{6}[NS]\s+[0-9]{7}[EW]$/;
const REGEX_ARC_DIR = /^(cw|ccw)$/;
const REGEX_ARC_RADIUS = /^(\d+(\.\d+)?)\s*(NM|nm)?$/;
const GEOJSON_SCHEMA = require('../schemas/geojson-schema.json');

class AirspaceConverter {
    /**
     * @param {Object} [config]
     * @param {Object} [config.validateGeometries] - Validate geometries. Defaults to true.
     * @param {Object} [config.fixGeometries] - Fix geometries that are not valid. Defaults to false.
     * @param {number} [config.geometryDetail] - Defines the steps that are used to calculate arcs and circles. Defaults to 100. Higher values mean smoother circles but a higher number of polygon points.
     * @param {boolean} [config.strictSchemaValidation] - If true, the created GEOJSON is validated against the underlying schema to enforce compatibility.
     * If false, simply warns on console about schema mismatch. Defaults to false.
     */
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        if (checkTypes.boolean(this.config.validateGeometries) === false) {
            throw new Error(
                `Missing or invalid config parameter 'validateGeometries': ${this.config.validateGeometries}`
            );
        }
        if (checkTypes.boolean(this.config.fixGeometries) === false) {
            throw new Error(`Missing or invalid config parameter 'fixGeometries': ${this.config.fixGeometries}`);
        }
        if (checkTypes.integer(this.config.geometryDetail) === false) {
            throw new Error(`Missing or invalid config parameter 'geometryDetail': ${this.config.geometryDetail}`);
        }
        if (checkTypes.boolean(this.config.strictSchemaValidation) === false) {
            throw new Error(
                `Missing or invalid config parameter 'strictSchemaValidation': ${this.config.strictSchemaValidation}`
            );
        }

        this.ajv = new Ajv({
            // nullable: true,
            verbose: true,
            allErrors: true,
            // jsonPointers: true,
        });
        // set all used formats
        addFormats(this.ajv, ['date-time', 'date']);
        // set all used keywords
        ajvKeywords(this.ajv, []);
        // add unknown keywords that would otherwise result in an exception
        this.ajv.addVocabulary(['example']);
        require('ajv-errors')(this.ajv);
        // add schema
        this.ajv.validateSchema(GEOJSON_SCHEMA);
        this.ajv.addSchema(GEOJSON_SCHEMA);
        this.schemaValidator = this.ajv.getSchema(
            'https://adhoc-schemas.openaip.net/schemas/parsed-aixm-airspace.json'
        );

        // used in error messages to better identify the airspace that caused the error
        this.ident = null;
        this.seqno = null;
        // keep track of all calculated coordinates for the currently processed airspace boundary
        this.boundaryCoordinates = [];
    }

    /**
     * Converts a buffer containing AIXM airspace data to GeoJSON.
     *
     * @param {Buffer} buffer
     * @param {Object} options
     * @param {Buffer} options.serviceFileBuffer - Buffer containing "service.yaml" file data.
     * @return {Object}
     */
    async convert(buffer, options) {
        this.reset();

        const { serviceFileBuffer } = options;

        if (checkTypes.instance(buffer, Buffer) === false) {
            throw new Error("Missing or invalid parameter 'buffer'");
        }
        if (serviceFileBuffer != null && checkTypes.instance(serviceFileBuffer, Buffer) === false) {
            throw new Error("Missing or invalid parameter 'serviceFileBuffer'");
        }

        var aixmJson = convert.xml2js(buffer, { compact: true, spaces: 4 });
        // build options for createAirspaceFeature
        const createOptions = {};
        const geojsonFeatures = [];
        for (const airspace of aixmJson['message:AIXMBasicMessage']['message:hasMember']) {
            geojsonFeatures.push(...(await this.createAirspaceFeature(airspace, createOptions)));
        }

        const geojson = createFeatureCollection(geojsonFeatures);
        const valid = this.schemaValidator(geojson);
        if (valid === false) {
            if (this.config.strictSchemaValidation) {
                throw new Error(
                    `GeoJSON does not adhere to underlying schema. ${JSON.stringify(this.schemaValidator.errors)}`
                );
            } else {
                console.log('WARN: GeoJSON does not adhere to underlying schema.');
            }
        }

        return geojson;
    }

    /**
     * @param {Object} airspaceJson
     * @param {Object} options
     * @return {Object}
     * @private
     */
    async createAirspaceFeature(airspaceJson, options) {
        const {} = options;
        const features = [];

        const properties = airspaceJson['aixm:Airspace']['aixm:timeSlice']['aixm:AirspaceTimeSlice'];
        const identifier = airspaceJson['aixm:Airspace']['gml:identifier']?._text;
        const name = properties['aixm:name']?._text;
        const designator = properties['aixm:designator']?._text;
        const type = properties['aixm:type']?._text;
        const localType = properties['aixm:localType']?._text;
        const icaoClass = properties['aixm:designatorICAO']?._text;
        const activation = properties['aixm:activation'];
        const geometryComponent =
            properties['aixm:geometryComponent']['aixm:AirspaceGeometryComponent']['aixm:theAirspaceVolume'][
                'aixm:AirspaceVolume'
            ];

        // set identifier for error messages
        this.ident = name;
        // map to only type/class combination
        const { type: mappedType, class: mappedClass, metaProps } = this.mapClassAndType(type, localType, icaoClass);

        const upperLimit = geometryComponent['aixm:upperLimit'];
        const upperLimitReference = geometryComponent['aixm:upperLimitReference'];
        const lowerLimit = geometryComponent['aixm:lowerLimit'];
        const lowerLimitReference = geometryComponent['aixm:lowerLimitReference'];
        const width = geometryComponent['aixm:width'];
        const surface = geometryComponent['aixm:horizontalProjection']['aixm:Surface'];

        const upperCeiling = this.createCeiling(upperLimit, upperLimitReference);
        const lowerCeiling = this.createCeiling(lowerLimit, lowerLimitReference);
        const feature = this.createPolygonFeature(surface, width);

        let geometry = feature.geometry;
        if (this.config.fixGeometries) {
            geometry = this.fixGeometry(feature.geometry);
        }
        if (this.config.validateGeometries) {
            const { isValid, selfIntersect } = this.validateGeometry(geometry);
            if (isValid === false) {
                let message = `Invalid geometry for airspace '${this.ident}' in sequence number '${this.seqno}'`;
                if (selfIntersect != null) {
                    message += `: Self intersection at ${JSON.stringify(selfIntersect)}`;
                }
                throw new Error(message);
            }
        }
        const polygonFeature = {
            type: 'Feature',
            // set "base" airspace properties that is common to all airspaces defined in AIXM  block. Each AIXM block can define
            // multiple airspaces, all with the same base properties.
            properties: {
                ...{
                    name,
                    type: mappedType,
                    class: mappedClass,
                    upperCeiling,
                    lowerCeiling,
                    activatedByNotam: rules?.includes('NOTAM') === true,
                    // set default value, will be overwritten by "metaProps" if applicable
                    activity: 'NONE',
                    remarks: rules == null ? null : rules.join(', '),
                },
                // merges updated field value for fields, e.g. "activity"
                ...metaProps,
            },
            geometry,
        };
        // add frequency property if services are available and mapping property "id" is set
        if (id != null && services != null) {
            feature.properties.groundService = await this.createGroundServiceProperty(id, services);
        }

        features.push(cleanDeep(feature));
        // IMPORTANT reset internal state for next airspace
        this.reset();

        return polygonFeature;
    }

    createGeometry(geometryComponent) {}

    /**
     * Maps ground service frequency to airspace if possible. Will return null if no mapping is found.
     *
     * @param {string} id
     * @param {Object[]} services
     * @return {Promise<Object|null>}
     * @private
     */
    async createGroundServiceProperty(id, services) {
        if (checkTypes.nonEmptyString(id) === false) {
            throw new Error("Missing or invalid parameter 'id'");
        }
        if (checkTypes.nonEmptyObject(services) === false) {
            throw new Error("Missing or invalid parameter 'services'");
        }

        try {
            // read services file
            for (const service of services.service) {
                const { callsign, controls, frequency } = service;
                // airspace "id" is mapped to "controls"" in services file
                if (controls?.includes(id)) {
                    return {
                        callsign,
                        frequency: frequency.toString(),
                    };
                }
            }

            return null;
        } catch (e) {
            // only warn if error
            console.log(`WARN: Failed to map ground station services. ${e.message}`);

            return null;
        }
    }

    /**
     * @param {string} type
     * @param {string} localType
     * @param {string} airspaceClass
     *
     * @return {{type: string, class: string, [metaProps]: Object}}
     */
    mapClassAndType(type, localType, airspaceClass) {
        let message = `Failed to map class/type combination for airspace '${this.ident}'.`;
        // check type is allowed
        if (ALLOWED_TYPES.includes(type) === false) {
            throw new Error(`${message} The 'type' value '${type}' is not in the list of allowed types.`);
        }
        if (localType != null && ALLOWED_LOCALTYPES.includes(localType) === false) {
            throw new Error(
                `${message} The 'localtype' value '${localType}' is not in the list of allowed localtypes.`
            );
        }
        if (airspaceClass != null && ALLOWED_CLASSES.includes(airspaceClass) === false) {
            throw new Error(`${message} The 'class' value '${airspaceClass}' is not in the list of allowed classes.`);
        }

        if (type != null && airspaceClass != null) {
            let mappedType = null;
            let mappedClass = null;

            switch (type) {
                case 'CTA':
                    mappedType = 'CTA';
                    break;
                case 'TMA':
                    mappedType = 'TMA';
                    break;
                case 'CTR':
                case 'CTR_P':
                    mappedType = 'CTR';
                    break;
                case 'ATZ':
                    mappedType = 'ATZ';
                    break;
                case 'D':
                    mappedType = 'DANGER';
                    break;
                case 'P':
                    mappedType = 'PROHIBITED';
                    break;
                case 'R':
                    mappedType = 'RESTRICTED';
                    break;
                default:
                    throw new Error(`${message} The 'type' value '${type}' has no configured mapping.`);
            }
            if (ALLOWED_CLASSES.includes(airspaceClass)) {
                // airspace class "NO" is replaced with "UNCLASSIFIED"
                mappedClass = airspaceClass === 'NO' ? 'UNCLASSIFIED' : airspaceClass;
            } else {
                throw new Error(`${message} The 'class' value '${airspaceClass}' has no configured mapping.`);
            }

            return { type: mappedType, class: mappedClass };
        } else if (type != null && localType != null) {
            const comb = `${type}|${localType}`;
            switch (comb) {
                case 'OTHER|MATZ':
                    return { type: 'MATZ', class: 'G' };
                case 'D_OTHER|GLIDER':
                    return { type: 'GLIDING_SECTOR', class: 'UNCLASSIFIED' };
                // gas venting station
                /*
                GVS - gas venting station
                HIRTA - high intensity radio transmission area
                LASER - "biu biu biu"
                ILS - ILS feather
                 */
                case 'D_OTHER|GVS':
                case 'D_OTHER|HIRTA':
                case 'D_OTHER|LASER':
                case 'OTHER|ILS':
                    return { type: 'WARNING', class: 'UNCLASSIFIED' };
                case 'D_OTHER|DZ':
                    return {
                        type: 'AERIAL_SPORTING_RECREATIONAL',
                        class: 'UNCLASSIFIED',
                        metaProps: { activity: 'PARACHUTING' },
                    };
                case 'OTHER|GLIDER':
                case 'OTHER|NOATZ':
                    return {
                        type: 'AERIAL_SPORTING_RECREATIONAL',
                        class: 'UNCLASSIFIED',
                        metaProps: { activity: 'AEROCLUB_AERIAL_WORK' },
                    };
                case 'OTHER|UL':
                    return {
                        type: 'AERIAL_SPORTING_RECREATIONAL',
                        class: 'UNCLASSIFIED',
                        metaProps: { activity: 'ULM' },
                    };
                case 'OTHER|RMZ':
                    return {
                        type: 'RMZ',
                        class: 'UNCLASSIFIED',
                    };
                case 'OTHER|TMZ':
                    return {
                        type: 'TMZ',
                        class: 'UNCLASSIFIED',
                    };
                default:
                    throw new Error(
                        `${message} The 'type' value '${type}' and 'localtype' value '${localType}' has no configured mapping.`
                    );
            }
        } else if (type != null) {
            switch (type) {
                case 'ATZ':
                case 'MATZ':
                    return { type, class: 'G' };
                case 'D':
                    return { type: 'DANGER', class: 'UNCLASSIFIED' };
                case 'P':
                    return { type: 'PROHIBITED', class: 'UNCLASSIFIED' };
                case 'R':
                    return { type: 'RESTRICTED', class: 'UNCLASSIFIED' };
                default:
                    throw new Error(`${message} The type value '${type}' has no configured mapping.`);
            }
        }

        throw new Error(
            `${message} No mapping for combination '${JSON.stringify({ type, localType, class: airspaceClass })}'`
        );
    }

    /**
     * Converts a AIXM limit object to
     * "{
     *      "value": 1500,
     *      "unit": "FT",
     *      "referenceDatum": "MSL"
     *  }"
     *
     *  This function assumes that only unit "ft" or "FL" or "SFC" is used in the ceiling definition.
     *
     * @param {Object} limit
     * @param {Object} referenceDatum
     * @return {Object}
     */
    createCeiling(limit, referenceDatum) {
        const limitValue = limit?._text;
        const limitUnitValue = limit?._attributes?.uom;
        const referenceDatumValue = referenceDatum?._text;

        if (limitValue == null && limitUnitValue == null && referenceDatumValue == null) {
            throw new Error(`Invalid ceiling definition for airspace '${this.ident}'`);
        }

        return {
            value: limitValue,
            unit: limitUnitValue,
            referenceDatum: referenceDatumValue,
        };
    }

    /**
     * Creates a GeoJSON Polygon geometry from a AIXM airspace boundary (geometry) definition.
     *
     * @param {Array} boundary
     * @return {Object}
     * @private
     */
    createPolygonFeature(boundary, width) {
        // depending on the geometry type, choose specific geometry type handler
        const geometryDefinition = boundary['gml:patches'];
        const isPolygonPatch = geometryDefinition.hasOwnProperty('gml:PolygonPatch');

        if (isPolygonPatch) {
            return this.createGeometryFromPolygonPatch(geometryDefinition);
        } else {
            throw new Error(
                `Unsupported geometry type '${Object.values(geometryDefinition).pop()}' for airspace '${this.ident}'`
            );
        }
    }

    /**
     * Creates a geometry from a polygon patch.
     *
     * @param {Object} geometryDefinition - The definition of the geometry.
     */
    createGeometryFromPolygonPatch(geometryDefinition) {
        const polygonPatch = geometryDefinition['gml:PolygonPatch'];
        const exterior = polygonPatch['gml:exterior'];
        const ring = exterior['gml:Ring'];
        const curveMember = ring['gml:curveMember'];
        const curve = curveMember['gml:Curve'];
        const segments = curve['gml:segments'];
        const geodesicString = segments['gml:GeodesicString'];

        // extract the coordinates from the segments

        const extractCoordinates = function (positions) {
            const coordinates = [];
            for (const pos of positions) {
                const [longitude, latitude] = pos?._text?.split(' ');
                coordinates.push([parseFloat(longitude), parseFloat(latitude)]);
            }

            return coordinates;
        };

        let coords = [];
        for (const pos of geodesicString) {
            const coordinates = extractCoordinates(pos['gml:pos']);
            coords = coords.concat(coordinates);
        }

        return createPolygon([coords]);
    }

    /**
     * @param {Object} geometry
     * @return {Object}
     * @private
     */
    fixGeometry(geometry) {
        let fixedGeometry = geometry;

        const { isValid, isSimple, selfIntersect } = this.validateGeometry(geometry);
        // IMPORTANT only run if required since process will slightly change the original airspace by creating a buffer
        //  which will lead to an increase of polygon coordinates
        if (!isValid || !isSimple || selfIntersect) {
            try {
                fixedGeometry = this.createFixedPolygon(geometry.coordinates[0]);
            } catch (e) {
                throw new Error(
                    `Failed to create fixed geometry for airspace '${this.ident}' in sequence number '${this.seqno}'. ${e.message}`
                );
            }
        }

        return fixedGeometry;
    }

    /**
     * Tries to create a valid Polygon geometry without any self-intersections and holes from the input coordinates.
     * This does ALTER the geometry and will return a new and valid geometry instead. Depending on the size of self-intersections,
     * holes and other errors, the returned geometry may differ A LOT from the original one!
     *
     * @param {Array[]} coordinates
     * @return {Object}
     * @private
     */
    createFixedPolygon(coordinates) {
        // prepare "raw" coordinates first before creating a polygon feature
        coordinates = this.removeDuplicates(coordinates);

        let polygon;
        try {
            coordinates = this.removeOverlapPoints(coordinates);
            const linestring = createLineString(coordinates);
            polygon = lineToPolygon(linestring);
            polygon = unkinkPolygon(polygon);
            // use the largest polygon in collection as the main polygon - assumed is that all kinks are smaller in size
            // and neglectable
            const getPolygon = function (features) {
                let polygon = null;
                let polygonArea = null;
                for (const feature of features) {
                    const area = getArea(feature);

                    if (area >= polygonArea) {
                        polygonArea = area;
                        polygon = feature;
                    }
                }

                return polygon;
            };
            polygon = getPolygon(polygon.features);

            return polygon.geometry;
        } catch (e) {
            /*
            Use "envelope" on edge cases that cannot be fixed with above logic. Resulting geometry will be
            completely changed but area enclosed by original airspace will be enclosed also. In case of single, dual point
            invalid polygons, this will at least return a valid geometry though it will differ the most from the original one.
             */
            try {
                const pointFeatures = [];
                for (const coord of coordinates) {
                    pointFeatures.push(createPoint(coord));
                }
                return envelope(createFeatureCollection(pointFeatures)).geometry;
            } catch (e) {
                throw new Error(e.message);
            }
        }
    }

    /**
     * @param {Object} geometry
     * @return {{isValid: boolean, isSimple: boolean, selfIntersect: (Object|null)}}
     * @private
     */
    validateGeometry(geometry) {
        // validate airspace geometry
        let isValid = this.isValid(geometry);
        let isSimple = this.isSimple(geometry);
        const selfIntersect = this.getSelfIntersections(geometry);

        return { isValid, isSimple, selfIntersect };
    }

    /**
     * @param {Object} polygonGeometry
     * @return {boolean}
     * @private
     */
    isValid(polygonGeometry) {
        const reader = new jsts.io.GeoJSONReader();
        const jstsGeometry = reader.read(polygonGeometry);
        const isValidValidator = new jsts.operation.valid.IsValidOp(jstsGeometry);

        return isValidValidator.isValid();
    }

    /**
     * @param {Object} polygonGeometry
     * @return {boolean}
     * @private
     */
    isSimple(polygonGeometry) {
        const reader = new jsts.io.GeoJSONReader();
        const jstsGeometry = reader.read(polygonGeometry);
        const isSimpleValidator = new jsts.operation.IsSimpleOp(jstsGeometry);

        return isSimpleValidator.isSimple();
    }

    /**
     * @param {Object} polygonGeometry
     * @return {Object|null}
     * @private
     */
    getSelfIntersections(polygonGeometry) {
        const reader = new jsts.io.GeoJSONReader();
        const jstsGeometry = reader.read(polygonGeometry);

        // if the geometry is already a simple linear ring, do not
        // try to find self intersection points.
        if (jstsGeometry) {
            const validator = new jsts.operation.IsSimpleOp(jstsGeometry);
            if (validator.isSimpleLinearGeometry(jstsGeometry)) {
                return;
            }

            let res = {};
            const graph = new jsts.geomgraph.GeometryGraph(0, jstsGeometry);
            const cat = new jsts.operation.valid.ConsistentAreaTester(graph);
            const r = cat.isNodeConsistentArea();
            if (!r) {
                res = cat.getInvalidPoint();
            }
            return res;
        }
    }

    /**
     * Removes high proximity coordinates, i.e. removes coordinate if another coordinate is within 10 meters.
     *
     * @params {Array[]} coordinates
     * @returns {Array[]}
     * @private
     */
    removeDuplicates(coordinates) {
        const processed = [];
        for (const coord of coordinates) {
            const exists = processed.find((value) => {
                return distance(value, coord, { units: 'kilometers' }) < 0.001;
            });

            if (exists === undefined) {
                processed.push(coord);
            }
        }

        return processed;
    }

    /**
     * Takes a list of coordinates and moves along all points and checks whether the traversed
     * path would form an overlapping line.
     *
     * @param {Array[]} coordinates
     * @return {Array[]}
     */
    removeOverlapPoints(coordinates) {
        const fixedPoints = [];
        let lastBearing = null;

        coordinates.forEach((coord, index) => {
            // get bearing to next point
            const nextPoint = coordinates[index + 1];
            let nextBearing = null;
            // calc bearing to next point if any, otherwise add last point and exit
            if (nextPoint) {
                nextBearing = parseInt(calcBearing(coord, nextPoint));
            } else {
                fixedPoints.push(coord);
                return;
            }
            // always use 360 instead of 0
            nextBearing = nextBearing === 0 ? 360 : nextBearing;
            // if next bearing is exactly the opposite direction, we found an overlapping part of the line string
            const oppBearing = parseInt(nextBearing > 360 && nextBearing < 180 ? nextBearing + 180 : nextBearing - 180);
            if (lastBearing == null || oppBearing !== lastBearing) {
                fixedPoints.push(coord);
                lastBearing = nextBearing;
            }
        });

        return fixedPoints;
    }

    /**
     * @return {void}
     * @private
     */
    reset() {
        this.ident = null;
        this.seqno = null;
        this.boundaryCoordinates = [];
    }
}

module.exports = { AirspaceConverter };
