/**
Decodes a Uniform Resource Identifier (URI) component previously created by `encodeURIComponent()`
or by a similar routine.

@param encodedURI - An encoded component of a URI.

@returns The decoded URI component.

@example
```
decodeUriComponent('st%C3%A5le')
//=> 'ståle'
```
*/
declare function decodeUriComponent(encodedURI: string): string;

// `export =`, not `export default`: the whole point of this package is that it
// is reachable from `require()`, which is how query-string 7 consumes it.
export = decodeUriComponent;
